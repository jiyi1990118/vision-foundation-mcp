import { createAnnotationWorkbenchServer } from '../src/ui-analysis/annotation-workbench/server.js';

const args = process.argv.slice(2);
const datasetDir = args.find((arg) => !arg.startsWith('--')) ?? 'benchmark/datasets/dev/app';
const portIndex = args.indexOf('--port');
const requestedPort = portIndex >= 0 ? Number(args[portIndex + 1]) : 4317;
const port = Number.isInteger(requestedPort) && requestedPort > 0 ? requestedPort : 4317;

const app = await createAnnotationWorkbenchServer(datasetDir);
await app.listen(port);
console.log(`Annotation workbench: http://127.0.0.1:${port}`);

async function shutdown(): Promise<void> {
  await app.close();
  process.exit(0);
}

process.once('SIGINT', () => { void shutdown(); });
process.once('SIGTERM', () => { void shutdown(); });
