const fs = require("node:fs");
const { setTimeout: delay } = require("node:timers/promises");

async function writeTestClock(file, time) {
  const next = file + ".next";
  fs.writeFileSync(next, String(time));
  const deadline = Date.now() + 2000;
  for (;;) {
    try {
      fs.renameSync(next, file);
      return;
    } catch (error) {
      // Windows readers or scanners can briefly hold the replacement target.
      if (!["EPERM", "EBUSY"].includes(error.code) || Date.now() >= deadline)
        throw error;
      await delay(25);
    }
  }
}
module.exports = { writeTestClock };
