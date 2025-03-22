# Monsters - metrics

This app is a npm package, that initializes metrics connections in `Monsters` project.

## How to set up

export NODE_METRICS_ADDRESS with address for otel collector

## How to use

Simply include the metrics file while starting your application. Example
```bash
NODE_ENV=development node --import ./metrics.js --experimental-loader=@opentelemetry/instrumentation/hook.mjs ./main.js  
```

Where metrics.js is this files location

In order for metrics to work, import promClient from this package and create endpoint /metrics, which will run `client.metrics()`. Example

```ts
    const app = express();

    app.get('/metrics', async (_req, res) => {
      res.set('Content-Type', client.contentType);
      res.end(client.metrics());
    });
```

