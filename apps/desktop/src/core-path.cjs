const { version } = require("../package.json");
// Versioned development binaries allow builds while the previous desktop is open.
const coreBinary = `troop-core-${version}${process.platform === "win32" ? ".exe" : ""}`;
module.exports = { coreBinary };
