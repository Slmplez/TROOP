const { CoreSupervisor } = require("../../src/core-client.cjs");
const client = new CoreSupervisor({
  executable: process.argv[2],
  args: ["--data-dir", process.argv[3]],
});
client
  .start()
  .then(() => console.log(JSON.stringify({ pid: client.child.pid })))
  .catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
