import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";

const config = loadConfig();
const { fastify } = await buildApp(config);

const shutdown = async (signal: string) => {
  fastify.log.info({ signal }, "shutting down");
  await fastify.close();
  process.exit(0);
};
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

await fastify.listen({ port: config.port, host: config.host });
