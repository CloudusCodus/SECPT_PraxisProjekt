import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import rateLimit from 'express-rate-limit';
import { createProxyMiddleware } from 'http-proxy-middleware';

// Load environment variables from a .env file if present. This allows
// developers to override default service URLs when running locally.
dotenv.config();

const app = express();
const PORT = process.env.PORT || '3000';

// Enable CORS to allow the frontend to communicate with this gateway
// even when served from a different origin (e.g. during local dev).
app.use(cors());

// Parse JSON request bodies
app.use(express.json());

// Simple logging middleware. Logs the HTTP method and path of each
// incoming request. For production a more robust logging solution
// would be advisable.
app.use((req: Request, _res: Response, next: NextFunction) => {
  console.log(`[Gateway] ${req.method} ${req.originalUrl}`);
  next();
});

// Rate limiting to prevent abuse. Limits each client IP to 100
// requests per 15 minute window. Adjust the window and max values as
// appropriate for your use case. The standardHeaders flag adds
// RateLimit-* headers which are understood by many HTTP clients.
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false
});
app.use(limiter);

// Resolve service base URLs. These environment variables are set by
// docker-compose when running in containers. When running locally
// without Docker they default to localhost and the exposed ports.
const USER_SERVICE_URL = process.env.USER_SERVICE_URL || 'http://localhost:3001';
const PRODUCT_SERVICE_URL = process.env.PRODUCT_SERVICE_URL || 'http://localhost:3002';
const ORDER_SERVICE_URL = process.env.ORDER_SERVICE_URL || 'http://localhost:3003';

// Create a proxy middleware for a given service. The pathRewrite
// option strips the leading route segment when forwarding so that
// requests remain consistent with the underlying service routes. For
// example, a request to /users/123 becomes /users/123 on the user
// service. Without path rewriting the target service would receive
// /users/users/123, which is incorrect.
function proxy(serviceUrl: string, route: string) {
  return createProxyMiddleware({
    target: serviceUrl,
    changeOrigin: true,
    pathRewrite: {
      [`^/${route}`]: `/${route}`
    },
    onError(err, req, res) {
      console.error(`[Gateway] Error forwarding ${req.method} ${req.originalUrl}:`, err.message);
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Bad gateway' }));
    }
  });
}

// Mount proxy routes. Each call to app.use associates a path prefix
// with the corresponding service. Any request that begins with one of
// these prefixes is forwarded to the appropriate backend. Additional
// prefixes can be added here as new services are introduced.
app.use('/users', proxy(USER_SERVICE_URL, 'users'));
app.use('/products', proxy(PRODUCT_SERVICE_URL, 'products'));
app.use('/orders', proxy(ORDER_SERVICE_URL, 'orders'));

// Catch-all handler for unknown routes. This prevents unknown paths
// from leaking through to a backend service and provides a uniform
// error response to the client.
app.all('*', (_req: Request, res: Response) => {
  res.status(404).json({ error: 'API endpoint not found' });
});

// Start the server
app.listen(Number(PORT), () => {
  console.log(`API Gateway listening on port ${PORT}`);
});