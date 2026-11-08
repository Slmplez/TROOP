const { app } = require("electron");
const { bootstrap } = require("./main.cjs");

bootstrap().catch((error) => {
  console.error(error.message);
  app.exit(1);
});
