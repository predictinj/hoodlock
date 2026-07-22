/* Compile contracts/RobinhoodLocker.sol → scripts/build/{abi.json,bytecode.txt}. */
const solc = require("solc");
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const outDir = path.join(__dirname, "build");
fs.mkdirSync(outDir, { recursive: true });

const src = fs.readFileSync(path.join(root, "contracts", "RobinhoodLocker.sol"), "utf8");
const input = {
  language: "Solidity",
  sources: { "RobinhoodLocker.sol": { content: src } },
  settings: { optimizer: { enabled: true, runs: 200 }, outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } } },
};
const out = JSON.parse(solc.compile(JSON.stringify(input)));
const errs = (out.errors || []).filter((e) => e.severity === "error");
if (errs.length) { errs.forEach((e) => console.error(e.formattedMessage)); process.exit(1); }
const c = out.contracts["RobinhoodLocker.sol"]["RobinhoodLocker"];
fs.writeFileSync(path.join(outDir, "abi.json"), JSON.stringify(c.abi, null, 2));
fs.writeFileSync(path.join(outDir, "bytecode.txt"), "0x" + c.evm.bytecode.object);
// also expose the ABI to the web app
fs.writeFileSync(path.join(root, "web", "src", "locker-abi.json"), JSON.stringify(c.abi, null, 2));
console.log("compiled OK — bytecode bytes:", c.evm.bytecode.object.length / 2, "| solc", solc.version());
