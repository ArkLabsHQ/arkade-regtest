import { createServer } from 'node:http';
import { FEED_PRICE, PRICEFEED_PORT } from './config.mjs';

/** Serves `{ "price": "<FEED_PRICE>" }` for the solver admin market probe + runtime. */
export function startPriceFeed(price = FEED_PRICE, port = PRICEFEED_PORT) {
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ price }));
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '0.0.0.0', () => {
      const url = `http://127.0.0.1:${port}/price`;
      console.log(`[pricefeed] ${url} → ${price}`);
      resolve({ server, url, price });
    });
  });
}
