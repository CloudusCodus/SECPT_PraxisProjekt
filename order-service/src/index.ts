import express, { Request, Response } from 'express';
import axios from 'axios';
import cors from 'cors';
import { v4 as uuidv4 } from 'uuid';
import { Pool } from 'pg';

// Order interface tracks the IDs of the user and product along with quantity
interface Order {
  id: string;
  userId: string;
  productId: string;
  quantity: number;
  /**
   * Status of the order. When the product service is reachable and the product
   * is validated the status will be 'CONFIRMED'. If the product service is
   * unavailable during order creation the order is stored with status
   * 'PENDING' and later processed asynchronously. Additional statuses such
   * as 'FAILED' could be introduced in the future.
   */
  status: string;
}

const app = express();
const PORT = process.env.PORT || 3003;

app.use(cors());
app.use(express.json());

// Use environment variables to resolve service endpoints. These values are provided
// via docker-compose so that the order service can locate its dependencies.
const USER_SERVICE_URL = process.env.USER_SERVICE_URL || 'http://localhost:3001';
const PRODUCT_SERVICE_URL = process.env.PRODUCT_SERVICE_URL || 'http://localhost:3002';

/*
 * ----------------------------------------------------------------------
 * Circuit breaker and retry support for product service calls
 *
 * In a distributed system a dependent service can become unavailable
 * temporarily. Repeatedly attempting to call that service can waste
 * resources and cause cascading failures. A simple circuit breaker is
 * implemented here to cut off repeated product service calls after a
 * configurable number of failures. When the breaker is open, any
 * attempt to fetch a product will immediately throw. After a cooldown
 * period the breaker enters a half‑open state and allows a single call
 * through.  If that call succeeds the breaker closes; if it fails the
 * breaker reopens for another cooldown.
 */
type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';
let circuitState: CircuitState = 'CLOSED';
let failureCount = 0;
const FAILURE_THRESHOLD = Number(process.env.FAILURE_THRESHOLD) || 3;
const OPEN_DURATION_MS = Number(process.env.OPEN_DURATION_MS) || 30000;
let openTimeout: NodeJS.Timeout | null = null;

function recordFailure() {
  failureCount++;
  // Only transition from CLOSED to OPEN when the threshold is exceeded
  if (circuitState === 'CLOSED' && failureCount >= FAILURE_THRESHOLD) {
    circuitState = 'OPEN';
    // Start a timer to enter half‑open state after the open duration
    openTimeout = setTimeout(() => {
      circuitState = 'HALF_OPEN';
      failureCount = 0;
    }, OPEN_DURATION_MS);
  }
}

function recordSuccess() {
  // Reset the failure count and close the circuit if we were half‑open
  failureCount = 0;
  if (circuitState === 'HALF_OPEN') {
    circuitState = 'CLOSED';
    if (openTimeout) {
      clearTimeout(openTimeout);
      openTimeout = null;
    }
  }
}

/**
 * Attempt to retrieve a product by ID from the product service.  This helper
 * enforces a simple circuit breaker pattern to avoid repeated attempts
 * against an unavailable service.  If the breaker is open an error is
 * thrown immediately.  A timeout is applied to the request to avoid
 * hanging indefinitely.
 *
 * @param productId The UUID of the product to fetch
 * @returns The JSON representation of the product
 * @throws If the product service is unreachable, times out or the circuit
 *         breaker is open/half‑open and the call fails
 */
async function safeGetProduct(productId: string) {
  if (circuitState === 'OPEN') {
    throw new Error('Circuit breaker open');
  }
  try {
    const response = await axios.get(`${PRODUCT_SERVICE_URL}/products/${productId}`, {
      timeout: Number(process.env.PRODUCT_REQUEST_TIMEOUT_MS) || 3000
    });
    recordSuccess();
    return response.data;
  } catch (error: any) {
    recordFailure();
    throw error;
  }
}

// PostgreSQL connection pool for orders
const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT) || 5432,
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
  database: process.env.DB_NAME || 'ordersdb'
});

// Create the orders table if it doesn't exist
// NOTE: This one-shot creation is kept (as requested), but we additionally
// perform a robust DB initialization with retries below to avoid race conditions.
pool
  .query(`
    CREATE TABLE IF NOT EXISTS orders (
      id UUID PRIMARY KEY,
      user_id UUID NOT NULL,
      product_id UUID NOT NULL,
      quantity INTEGER NOT NULL,
      status TEXT NOT NULL
    )
  `)
  .catch((err) => {
    console.error('Error creating orders table', err);
  });

/* ------------------------------------------------------------------
   ✅ ADDED: DATABASE INITIALIZATION (Retry + ensure schema)
   ------------------------------------------------------------------
   Problem we prevent:
   - When the service starts before Postgres is ready, the one-shot CREATE TABLE
     above may fail once and never be retried.
   - The service would still start and later crash with "relation does not exist".

   Solution:
   1) Wait until Postgres is reachable (retry loop)
   2) Ensure the required table exists
   3) Start HTTP server only after init completed successfully
------------------------------------------------------------------- */

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function initDb() {
  // Retry loop to wait until PostgreSQL is reachable. This is needed because
  // docker-compose "depends_on" does not guarantee that Postgres is ready to accept connections.
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

  // Ensure the orders table exists before handling requests.  The table now
  // includes a 'status' column to persist whether an order is pending or
  // confirmed.  Use an ALTER statement afterwards to gracefully add the
  // column when upgrading from older schemas.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS orders (
      id UUID PRIMARY KEY,
      user_id UUID NOT NULL,
      product_id UUID NOT NULL,
      quantity INTEGER NOT NULL,
      status TEXT NOT NULL
    )
  `);

  // In case the table was created by a previous version without a status
  // column, add it here.  IF NOT EXISTS prevents errors if the column
  // already exists.  We do not set a default so that the service
  // explicitly chooses the status when inserting records.
  await pool.query('ALTER TABLE orders ADD COLUMN IF NOT EXISTS status TEXT');

  console.log('[db] Orders table ensured and updated (status column present)');
}

/* ------------------------------------------------------------------
   ROUTES (unchanged)
   ------------------------------------------------------------------ */

// Retrieve all orders. Supports optional filtering by userId and/or productId via
// query parameters. If no filters are provided all orders are returned.
app.get('/orders', async (req: Request, res: Response) => {
  const { userId, productId } = req.query as { userId?: string; productId?: string };
  try {
    let query =
      'SELECT id, user_id as "userId", product_id as "productId", quantity, status FROM orders';
    const values: any[] = [];
    if (userId && productId) {
      query += ' WHERE user_id = $1 AND product_id = $2';
      values.push(userId, productId);
    } else if (userId) {
      query += ' WHERE user_id = $1';
      values.push(userId);
    } else if (productId) {
      query += ' WHERE product_id = $1';
      values.push(productId);
    }
    const result = await pool.query(query, values);
    res.json(result.rows);
  } catch (err: any) {
    console.error('Error retrieving orders', err);
    res.status(500).json({ error: 'Failed to retrieve orders' });
  }
});

// Retrieve an order by ID. Optionally includes user and product details. If
// user or product lookups fail, only the order is returned.
app.get('/orders/:id', async (req: Request, res: Response) => {
  const orderId = req.params.id;
  try {
    const result = await pool.query(
      'SELECT id, user_id as "userId", product_id as "productId", quantity, status FROM orders WHERE id = $1',
      [orderId]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Order not found' });
    }
    const order = result.rows[0];
    try {
      // Always attempt to fetch the user.  If the user service is down the
      // order is returned without user info, matching previous behaviour.
      const userRes = await axios.get(`${USER_SERVICE_URL}/users/${order.userId}`);
      // Use the circuit breaker aware helper for retrieving the product.  This
      // prevents cascading failures if the product service is down.  Any
      // failure (including an open circuit) will result in the order being
      // returned without product details.
      let productData: any | undefined;
      try {
        productData = await safeGetProduct(order.productId);
      } catch (_err) {
        productData = undefined;
      }
      if (productData) {
        res.json({ order, user: userRes.data, product: productData });
      } else {
        res.json({ order, user: userRes.data });
      }
    } catch (_ignore) {
      res.json(order);
    }
  } catch (err: any) {
    console.error('Error retrieving order', err);
    res.status(500).json({ error: 'Failed to retrieve order' });
  }
});

// Create a new order by calling the user and product services to fetch
// additional data. If either service call fails, the request will error.
app.post('/orders', async (req: Request, res: Response) => {
  const { userId, productId, quantity } = req.body;
  if (!userId || !productId || quantity === undefined) {
    return res.status(400).json({ error: 'Missing userId, productId or quantity' });
  }
  try {
    // Validate that the user exists. If this fails we return an error rather
    // than storing the order because a nonexistent user should never be
    // persisted.
    const userRes = await axios.get(`${USER_SERVICE_URL}/users/${userId}`, {
      timeout: Number(process.env.USER_REQUEST_TIMEOUT_MS) || 3000
    });

    // Attempt to fetch the product.  If this call fails due to a timeout,
    // service outage or circuit breaker the order will be stored with
    // status PENDING.  A background worker will retry the product lookup
    // later.  On success the order status will be CONFIRMED.
    let productData: any | undefined;
    let status = 'CONFIRMED';
    try {
      productData = await safeGetProduct(productId);
    } catch (_err) {
      status = 'PENDING';
      productData = undefined;
    }

    // Construct the order and add it to our store along with its status
    const order: Order = {
      id: uuidv4(),
      userId,
      productId,
      quantity: Number(quantity),
      status
    };
    await pool.query(
      'INSERT INTO orders (id, user_id, product_id, quantity, status) VALUES ($1, $2, $3, $4, $5)',
      [order.id, order.userId, order.productId, order.quantity, order.status]
    );

    // Build the response payload.  Always include the order and user.  Include
    // the product details only when available.  Use HTTP 201 for confirmed
    // orders and 202 (Accepted) for pending ones.
    const responsePayload: any = { order, user: userRes.data };
    if (productData) {
      responsePayload.product = productData;
    }
    if (status === 'CONFIRMED') {
      res.status(201).json(responsePayload);
    } else {
      res.status(202).json(responsePayload);
    }
  } catch (error: any) {
    console.error('Error creating order', error.message);
    // Propagate validation errors (e.g. invalid user ID) to the client
    if (error.response && error.response.status === 404) {
      return res.status(400).json({ error: 'Invalid userId or productId' });
    }
    res.status(500).json({ error: 'Failed to create order' });
  }
});

// Update an existing order. Accepts userId, productId and/or quantity and
// applies partial updates. Validates referenced IDs by calling the user and
// product services. Returns the updated order along with user and product
// details when available.
app.put('/orders/:id', async (req: Request, res: Response) => {
  const orderId = req.params.id;
  const { userId, productId, quantity } = req.body;
  if (!userId && !productId && quantity === undefined) {
    return res.status(400).json({ error: 'Nothing to update' });
  }
  try {
    // Fetch existing order
    const existingRes = await pool.query(
      'SELECT id, user_id as "userId", product_id as "productId", quantity FROM orders WHERE id = $1',
      [orderId]
    );
    if (existingRes.rows.length === 0) {
      return res.status(404).json({ error: 'Order not found' });
    }
    let current = existingRes.rows[0];
    const updates: string[] = [];
    const values: any[] = [];
    let index = 1;
    // Validate referenced user and product IDs if provided.  When updating
    // a product we use the circuit breaker aware helper to determine if
    // the product service is reachable.  The order status will be set
    // accordingly below.
    try {
      if (userId) {
        await axios.get(`${USER_SERVICE_URL}/users/${userId}`, {
          timeout: Number(process.env.USER_REQUEST_TIMEOUT_MS) || 3000
        });
        updates.push(`user_id = $${index++}`);
        values.push(userId);
        current.userId = userId;
      }
      if (productId) {
        // Validate product using safeGetProduct to update circuit state.
        try {
          await safeGetProduct(productId);
        } catch (_ignore) {
          // ignore here; status will be set later
        }
        updates.push(`product_id = $${index++}`);
        values.push(productId);
        current.productId = productId;
      }
    } catch (err: any) {
      console.error('Error validating order update', err.message || err);
      return res.status(400).json({ error: 'Invalid userId or productId' });
    }
    if (quantity !== undefined) {
      const parsedQty = Number(quantity);
      if (isNaN(parsedQty) || parsedQty <= 0) {
        return res.status(400).json({ error: 'Invalid quantity' });
      }
      updates.push(`quantity = $${index++}`);
      values.push(parsedQty);
      current.quantity = parsedQty;
    }

    // Determine new status based on whether the product service is reachable
    let newStatus = 'CONFIRMED';
    try {
      await safeGetProduct(current.productId);
      newStatus = 'CONFIRMED';
    } catch (_err) {
      newStatus = 'PENDING';
    }
    updates.push(`status = $${index++}`);
    values.push(newStatus);
    current.status = newStatus;

    values.push(orderId);
    await pool.query(`UPDATE orders SET ${updates.join(', ')} WHERE id = $${index}`, values);
    // Build the response.  Attempt to fetch user and product details like
    // the GET handler.  Errors are ignored and only the order is returned.
    try {
      const userRes = await axios.get(`${USER_SERVICE_URL}/users/${current.userId}`, {
        timeout: Number(process.env.USER_REQUEST_TIMEOUT_MS) || 3000
      });
      let productData: any | undefined;
      try {
        productData = await safeGetProduct(current.productId);
      } catch (_ignore) {
        productData = undefined;
      }
      if (productData) {
        return res.json({ order: current, user: userRes.data, product: productData });
      }
      return res.json({ order: current, user: userRes.data });
    } catch (_ignore) {
      return res.json({ order: current });
    }
  } catch (err: any) {
    console.error('Error updating order', err);
    res.status(500).json({ error: 'Failed to update order' });
  }
});

// Delete an order. Removes the record from the database.
app.delete('/orders/:id', async (req: Request, res: Response) => {
  const orderId = req.params.id;
  try {
    // Verify order exists
    const existing = await pool.query('SELECT id FROM orders WHERE id = $1', [orderId]);
    if (existing.rowCount === 0) {
      return res.status(404).json({ error: 'Order not found' });
    }
    await pool.query('DELETE FROM orders WHERE id = $1', [orderId]);
    res.json({ message: 'Order deleted successfully' });
  } catch (err: any) {
    console.error('Error deleting order', err);
    res.status(500).json({ error: 'Failed to delete order' });
  }
});

/* ------------------------------------------------------------------
   ✅ ADDED: SERVICE STARTUP (listen only after DB init)
   ------------------------------------------------------------------
   We start the HTTP server only after initDb() succeeded.
   This guarantees that the required table exists before any request hits the service.
------------------------------------------------------------------- */

initDb()
  .then(() => {
    app.listen(Number(PORT), () => {
      console.log(`Order service listening on port ${PORT}`);
    });

    /*
     * ----------------------------------------------------------------------
     * Background worker to process pending orders
     *
     * When the product service is unavailable at the time of order creation,
     * the order is persisted with status 'PENDING'.  The worker below
     * periodically queries for such orders and attempts to contact the
     * product service.  On success the order status is updated to
     * 'CONFIRMED'.  Failures are logged but do not throw, so the loop
     * continues.  The retry interval and query limit can be tuned via
     * environment variables.
     */
    const retryIntervalMs = Number(process.env.PENDING_RETRY_INTERVAL_MS) || 10000;
    async function processPendingOrders() {
      try {
        const pending = await pool.query(
          'SELECT id, user_id as "userId", product_id as "productId", quantity, status FROM orders WHERE status = $1',
          ['PENDING']
        );
        for (const pendingOrder of pending.rows) {
          try {
            await safeGetProduct(pendingOrder.productId);
            // If we can now reach the product service, mark the order as confirmed
            await pool.query('UPDATE orders SET status = $1 WHERE id = $2', [
              'CONFIRMED',
              pendingOrder.id
            ]);
            console.log(`[worker] Order ${pendingOrder.id} confirmed`);
          } catch (err: any) {
            // Keep the order pending and log the failure for observability
            console.log(
              `[worker] Order ${pendingOrder.id} still pending: ${err?.message || err}`
            );
          }
        }
      } catch (err) {
        console.error('[worker] Error processing pending orders', err);
      }
    }
    // Kick off the worker loop
    setInterval(processPendingOrders, retryIntervalMs);
  })
  .catch((err) => {
    console.error('Fatal DB initialization error:', err);
    process.exit(1);
  });
