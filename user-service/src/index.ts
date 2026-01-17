import express, { Request, Response } from 'express';
import cors from 'cors';
import { v4 as uuidv4 } from 'uuid';
import { Pool } from 'pg';
import axios from 'axios';

// Define a user model to illustrate type-safety across the service
// This interface represents the data structure stored in the user database
interface User {
  id: string;
  name: string;
  email: string;
}

const app = express();
const PORT = process.env.PORT || 3001;

// Enable CORS and JSON body parsing middleware
app.use(cors());
app.use(express.json());

// Set up PostgreSQL connection pool using environment variables.
// The pool manages multiple connections efficiently and is reused
// across all incoming HTTP requests.
const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT) || 5432,
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
  database: process.env.DB_NAME || 'usersdb'
});

// Resolve order service URL for validating user deletions.
// When running in Docker Compose, this value is provided via environment variables.
// When running locally, it falls back to localhost.
const ORDER_SERVICE_URL = process.env.ORDER_SERVICE_URL || 'http://localhost:3003';

/* ------------------------------------------------------------------
   DATABASE INITIALIZATION
   ------------------------------------------------------------------
   This section ensures that:
   1) PostgreSQL is fully reachable before the service starts
   2) The required database table exists before handling requests

   Without this explicit initialization, the service could start
   before the database is ready, leading to runtime errors such as
   "relation does not exist" during INSERT or SELECT operations.
------------------------------------------------------------------- */

// Utility helper to pause execution for a given number of milliseconds
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function initDb() {
  // Retry loop to wait until PostgreSQL is reachable.
  // This is necessary because Docker may start the application
  // container before the database is fully initialized.
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

  // Create the users table if it does not already exist.
  // This ensures the schema is available before any request
  // attempts to read or write user data.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id UUID PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT NOT NULL
    )
  `);

  console.log('[db] Users table ensured');
}

/* ------------------------------------------------------------------
   ROUTES
   ------------------------------------------------------------------ */

// Retrieve all users
app.get('/users', async (req: Request, res: Response) => {
  try {
    const result = await pool.query('SELECT id, name, email FROM users');
    res.json(result.rows);
  } catch (err: any) {
    console.error('Error retrieving users', err);
    res.status(500).json({ error: 'Failed to retrieve users' });
  }
});

// Create a new user
// Expects a JSON body containing "name" and "email"
app.post('/users', async (req: Request, res: Response) => {
  const { name, email } = req.body;

  // Basic input validation
  if (!name || !email) {
    return res.status(400).json({ error: 'Missing name or email' });
  }

  const newUser: User = {
    id: uuidv4(),
    name,
    email
  };

  try {
    await pool.query(
      'INSERT INTO users (id, name, email) VALUES ($1, $2, $3)',
      [newUser.id, newUser.name, newUser.email]
    );
    res.status(201).json(newUser);
  } catch (err: any) {
    console.error('Error creating user', err);
    res.status(500).json({ error: 'Failed to create user' });
  }
});

// Retrieve a single user by ID
app.get('/users/:id', async (req: Request, res: Response) => {
  const userId = req.params.id;

  try {
    const result = await pool.query(
      'SELECT id, name, email FROM users WHERE id = $1',
      [userId]
    );

    if (result.rows.length > 0) {
      res.json(result.rows[0]);
    } else {
      res.status(404).json({ error: 'User not found' });
    }
  } catch (err: any) {
    console.error('Error retrieving user', err);
    res.status(500).json({ error: 'Failed to retrieve user' });
  }
});

// Update an existing user
// Supports partial updates of name and/or email
app.put('/users/:id', async (req: Request, res: Response) => {
  const userId = req.params.id;
  const { name, email } = req.body;

  if (!name && !email) {
    return res.status(400).json({ error: 'Missing name or email' });
  }

  try {
    // Check if the user exists
    const existing = await pool.query('SELECT id FROM users WHERE id = $1', [userId]);
    if (existing.rowCount === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const updates: string[] = [];
    const values: any[] = [];
    let index = 1;

    if (name) {
      updates.push(`name = $${index++}`);
      values.push(name);
    }

    if (email) {
      updates.push(`email = $${index++}`);
      values.push(email);
    }

    values.push(userId);

    await pool.query(
      `UPDATE users SET ${updates.join(', ')} WHERE id = $${index}`,
      values
    );

    const updated = await pool.query(
      'SELECT id, name, email FROM users WHERE id = $1',
      [userId]
    );

    res.json(updated.rows[0]);
  } catch (err: any) {
    console.error('Error updating user', err);
    res.status(500).json({ error: 'Failed to update user' });
  }
});

// Delete a user
// Before deletion, the service verifies that no existing orders
// reference the user by querying the order service.
app.delete('/users/:id', async (req: Request, res: Response) => {
  const userId = req.params.id;

  try {
    const existing = await pool.query('SELECT id FROM users WHERE id = $1', [userId]);
    if (existing.rowCount === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const orderRes = await axios.get(`${ORDER_SERVICE_URL}/orders`, {
      params: { userId }
    });

    if (Array.isArray(orderRes.data) && orderRes.data.length > 0) {
      return res.status(400).json({
        error: 'Cannot delete user with existing orders. Delete associated orders first.'
      });
    }

    await pool.query('DELETE FROM users WHERE id = $1', [userId]);
    res.json({ message: 'User deleted successfully' });
  } catch (err: any) {
    console.error('Error deleting user', err);
    res.status(500).json({ error: 'Failed to delete user' });
  }
});

/* ------------------------------------------------------------------
   SERVICE STARTUP
   ------------------------------------------------------------------
   The HTTP server is started only after the database initialization
   has completed successfully. This guarantees that all required
   database structures are present before handling any requests.
------------------------------------------------------------------- */

initDb()
  .then(() => {
    app.listen(Number(PORT), () => {
      console.log(`User service listening on port ${PORT}`);
    });
  })
  .catch((err) => {
    console.error('Fatal DB initialization error:', err);
    process.exit(1);
  });
