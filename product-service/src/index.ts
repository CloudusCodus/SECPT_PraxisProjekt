import express, { Request, Response } from 'express';
import cors from 'cors';
import { v4 as uuidv4 } from 'uuid';
import { Pool } from 'pg';
import axios from 'axios';

// Product model used within the service.
// This interface represents the structure stored in the products database.
interface Product {
  id: string;
  name: string;
  price: number;
}

const app = express();
const PORT = process.env.PORT || 3002;

// Enable CORS and JSON body parsing middleware
app.use(cors());
app.use(express.json());

// Set up PostgreSQL connection pool using environment variables.
// The pool manages reusable connections for database operations.
const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT) || 5432,
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
  database: process.env.DB_NAME || 'productsdb'
});

// Resolve order service URL for validating product deletions.
// In docker-compose this is usually injected via environment variables;
// when running locally it defaults to localhost:3003.
const ORDER_SERVICE_URL = process.env.ORDER_SERVICE_URL || 'http://localhost:3003';

/* ------------------------------------------------------------------
   DATABASE INITIALIZATION
   ------------------------------------------------------------------
   This service requires a "products" table. During container startup,
   Docker may start the application before PostgreSQL is fully ready.

   If the table creation is executed only once and fails (e.g., DB is
   still starting up), the service would keep running but later fail
   with "relation does not exist" errors.

   To prevent this, we:
   1) Wait until PostgreSQL is reachable (retry loop)
   2) Ensure the required schema (CREATE TABLE IF NOT EXISTS)
   3) Start the HTTP server only after DB initialization succeeded
------------------------------------------------------------------- */

// Utility helper to pause execution for a given number of milliseconds
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function initDb() {
  // Retry loop to wait until PostgreSQL is reachable.
  // This prevents flaky startup behavior when the DB container is still initializing.
  for (let attempt = 1; attempt <= 30; attempt++) {
    try {
      await pool.query('SELECT 1');
      console.log(`[db] PostgreSQL reachable (attempt ${attempt})`);
      break;
    } catch {
      console.log(`[db] PostgreSQL not ready yet (attempt ${attempt})`);
      if (attempt === 30) {
        throw new Error('PostgreSQL not reachable after multiple attempts');
      }
      await sleep(1000);
    }
  }

  // Ensure the required "products" table exists before processing any requests.
  // Note: price is stored as NUMERIC to avoid floating point rounding issues in the DB.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS products (
      id UUID PRIMARY KEY,
      name TEXT NOT NULL,
      price NUMERIC NOT NULL
    )
  `);

  console.log('[db] Products table ensured');
}

/* ------------------------------------------------------------------
   ROUTES
   ------------------------------------------------------------------ */

// Retrieve all products
app.get('/products', async (req: Request, res: Response) => {
  try {
    const result = await pool.query('SELECT id, name, price FROM products');

    // Convert the NUMERIC price field (returned as string by pg) into a number
    // for consistent JSON output.
    const products = result.rows.map((row) => ({
      id: row.id,
      name: row.name,
      price: parseFloat(row.price)
    }));

    res.json(products);
  } catch (err: any) {
    console.error('Error retrieving products', err);
    res.status(500).json({ error: 'Failed to retrieve products' });
  }
});

// Create a new product
// Expects a JSON body containing "name" and "price"
app.post('/products', async (req: Request, res: Response) => {
  const { name, price } = req.body;

  // Basic input validation
  if (!name || price === undefined) {
    return res.status(400).json({ error: 'Missing name or price' });
  }

  const parsedPrice = Number(price);
  if (isNaN(parsedPrice)) {
    return res.status(400).json({ error: 'Invalid price' });
  }

  const newProduct: Product = { id: uuidv4(), name, price: parsedPrice };

  try {
    await pool.query('INSERT INTO products (id, name, price) VALUES ($1, $2, $3)', [
      newProduct.id,
      newProduct.name,
      newProduct.price
    ]);
    res.status(201).json(newProduct);
  } catch (err: any) {
    console.error('Error creating product', err);
    res.status(500).json({ error: 'Failed to create product' });
  }
});

// Retrieve a product by ID
app.get('/products/:id', async (req: Request, res: Response) => {
  const productId = req.params.id;

  try {
    const result = await pool.query('SELECT id, name, price FROM products WHERE id = $1', [
      productId
    ]);

    if (result.rows.length > 0) {
      const row = result.rows[0];
      res.json({ id: row.id, name: row.name, price: parseFloat(row.price) });
    } else {
      res.status(404).json({ error: 'Product not found' });
    }
  } catch (err: any) {
    console.error('Error retrieving product', err);
    res.status(500).json({ error: 'Failed to retrieve product' });
  }
});

// Update an existing product (partial update)
// Accepts name and/or price and applies partial updates.
app.put('/products/:id', async (req: Request, res: Response) => {
  const productId = req.params.id;
  const { name, price } = req.body;

  if (!name && price === undefined) {
    return res.status(400).json({ error: 'Missing name or price' });
  }

  const updates: string[] = [];
  const values: any[] = [];
  let index = 1;

  if (name) {
    updates.push(`name = $${index++}`);
    values.push(name);
  }

  if (price !== undefined) {
    const parsedPrice = Number(price);
    if (isNaN(parsedPrice)) {
      return res.status(400).json({ error: 'Invalid price' });
    }
    updates.push(`price = $${index++}`);
    values.push(parsedPrice);
  }

  values.push(productId);

  try {
    // Verify the product exists
    const existing = await pool.query('SELECT id FROM products WHERE id = $1', [productId]);
    if (existing.rowCount === 0) {
      return res.status(404).json({ error: 'Product not found' });
    }

    await pool.query(`UPDATE products SET ${updates.join(', ')} WHERE id = $${index}`, values);

    const result = await pool.query('SELECT id, name, price FROM products WHERE id = $1', [productId]);
    const row = result.rows[0];

    res.json({ id: row.id, name: row.name, price: parseFloat(row.price) });
  } catch (err: any) {
    console.error('Error updating product', err);
    res.status(500).json({ error: 'Failed to update product' });
  }
});

// Delete a product
// Before deletion, the service checks with the order service whether any orders
// still reference the product. If so, deletion is refused to avoid broken references.
app.delete('/products/:id', async (req: Request, res: Response) => {
  const productId = req.params.id;

  try {
    const existing = await pool.query('SELECT id FROM products WHERE id = $1', [productId]);
    if (existing.rowCount === 0) {
      return res.status(404).json({ error: 'Product not found' });
    }

    // Query order service for orders referencing this product
    try {
      const orderRes = await axios.get(`${ORDER_SERVICE_URL}/orders`, {
        params: { productId }
      });

      const orders = orderRes.data;
      if (Array.isArray(orders) && orders.length > 0) {
        return res.status(400).json({
          error: 'Cannot delete product with existing orders. Delete associated orders first.'
        });
      }
    } catch (orderErr: any) {
      console.error(
        'Error validating product deletion with order service',
        orderErr.message || orderErr
      );
      return res.status(500).json({ error: 'Failed to validate product deletion' });
    }

    await pool.query('DELETE FROM products WHERE id = $1', [productId]);
    res.json({ message: 'Product deleted successfully' });
  } catch (err: any) {
    console.error('Error deleting product', err);
    res.status(500).json({ error: 'Failed to delete product' });
  }
});

/* ------------------------------------------------------------------
   SERVICE STARTUP
   ------------------------------------------------------------------
   Start the HTTP server only after DB initialization completed.
   This guarantees that the "products" table exists before any request
   can access it.
------------------------------------------------------------------- */

initDb()
  .then(() => {
    app.listen(Number(PORT), () => {
      console.log(`Product service listening on port ${PORT}`);
    });
  })
  .catch((err) => {
    console.error('Fatal DB initialization error:', err);
    process.exit(1);
  });
