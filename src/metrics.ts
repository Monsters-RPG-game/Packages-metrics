// import * as api from '@opentelemetry/api';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-http';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { ExpressInstrumentation } from '@opentelemetry/instrumentation-express';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { BatchLogRecordProcessor } from '@opentelemetry/sdk-logs';
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions';
import { register, Gauge } from 'prom-client';

// if (process.env.NODE_ENV !== 'production') api.diag.setLogger(new api.DiagConsoleLogger(), api.DiagLogLevel.DEBUG);

/**
 * Create new gauge.
 * @param name Name of gauge.
 * @param help Help tooltip.
 */
function createGauge(name: string, help: string): Gauge {
  return new Gauge({
    name,
    help,
  });
}

// Configs
const address = process.env.NODE_METRICS_ADDRESS;

const cpuUsage = createGauge('node_cpu_usage', 'CPU usage in percentage');
const memoryUsage = createGauge('node_memory_usage_bytes', 'Memory usage in bytes');
const eventLoopDelay = createGauge('node_event_loop_delay', 'Event loop delay');
const heapUsed = createGauge('node_heap_used', 'Heap used');
const heapTotal = createGauge('node_heap_total', 'Heap total');
const uptime = createGauge('node_uptime', 'Uptime');

/**
 * Initialize gauges and update their data.
 */
function updateSystemMetrics(): void {
  const cpuUsageData = process.cpuUsage().system / 1000;
  const memoryUsageData = process.memoryUsage().rss;
  const eventLoopDelayData = Number(process.hrtime.bigint()) - process.uptime();
  const { heapUsed: heapUsedData } = process.memoryUsage();
  const { heapTotal: heapTotalData } = process.memoryUsage();
  const uptimeData = process.uptime();

  cpuUsage.set(cpuUsageData);
  memoryUsage.set(memoryUsageData);
  eventLoopDelay.set(eventLoopDelayData);
  heapUsed.set(heapUsedData);
  heapTotal.set(heapTotalData);
  uptime.set(uptimeData);
}

setInterval(updateSystemMetrics, 5000);

register.registerMetric(cpuUsage);
register.registerMetric(memoryUsage);
register.registerMetric(eventLoopDelay);
register.registerMetric(heapUsed);
register.registerMetric(heapTotal);
register.registerMetric(uptime);

const traceExporter = new OTLPTraceExporter({
  url: `${address}/traces`,
  timeoutMillis: 10000,
});

const analitics = new NodeSDK({
  resource: resourceFromAttributes({
    [ATTR_SERVICE_NAME]: 'gateway',
  }),
  traceExporter,
  spanProcessors: [new SimpleSpanProcessor(traceExporter)],
  metricReader: new PeriodicExportingMetricReader({
    exportIntervalMillis: 10000,
    exporter: new OTLPMetricExporter({
      url: `${address}/metrics`,
    }),
  }),
  logRecordProcessors: [
    new BatchLogRecordProcessor(
      new OTLPLogExporter({
        url: `${address}/logs`,
      }),
    ),
  ],
  instrumentations: [new HttpInstrumentation(), new ExpressInstrumentation(), getNodeAutoInstrumentations()],
});

analitics.start();

process.on('SIGTERM', () => {
  console.info('Flushing telemetry before exit...');
  analitics
    .shutdown()
    .then(() => {
      console.info('Server', 'Analitics closed');
      process.exit(0);
    })
    .catch((err) => {
      console.info('Server', 'Got error while closing analitics', (err as Error).message);
      process.exit(1);
    });
});
