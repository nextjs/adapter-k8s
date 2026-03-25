// src/pool-server/server.ts
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

export interface PoolServerOptions {
  onRequest: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;
  port: number;
}

export function createPoolServer(options: PoolServerOptions) {
  const { onRequest, port } = options;

  const server: Server = createServer(async (req, res) => {
    // Health check — bypass all routing
    if (req.url === '/healthz') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok' }));
      return;
    }

    try {
      await onRequest(req, res);
    } catch (err) {
      console.error('Unhandled request error:', err);
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'text/plain' });
        res.end('Internal Server Error');
      } else if (!res.writableEnded) {
        res.end();
      }
    }
  });

  return {
    start(): Promise<{ port: number }> {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, () => {
          const addr = server.address();
          if (!addr || typeof addr === 'string') {
            reject(new Error('Failed to get server address'));
            return;
          }
          console.log(`Pool server listening on port ${addr.port}`);
          resolve({ port: addr.port });
        });
      });
    },

    close(): Promise<void> {
      return new Promise((resolve, reject) => {
        server.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      });
    },

    get server() { return server; },
  };
}
