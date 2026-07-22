/* Compile contracts/*.sol → scripts/build/<Name>.{abi.json,bytecode.txt} and
   expose each ABI to the web app as web/src/<name>-abi.json. */
const solc = require("solc");
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const outDir = path.join(__dirname, "build");
fs.mkdirSync(outDir, { recursive: true });

const CONTRACTS = [
  { file: "RobinhoodLocker.sol", name: "RobinhoodLocker", webAbi: "locker-abi.json", legacy: true },
  { file: "RobinhoodBurner.sol", name: "RobinhoodBurner", webAbi: "burner-abi.json" },
];

const sources = {};
for (const c of CONTRACTS) sources[c.file] = { content: fs.readFileSync(path.join(root, "contracts", c.file), "utf8") };
const input = {
  language: "Solidity",
  sources,
  settings: { optimizer: { enabled: true, runs: 200 }, outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } } },
};
const out = JSON.parse(solc.compile(JSON.stringify(input)));
const errs = (out.errors || []).filter((e) => e.severity === "error");
if (errs.length) { errs.forEach((e) => console.error(e.formattedMessage)); process.exit(1); }

for (const c of CONTRACTS) {
  const art = out.contracts[c.file][c.name];
  fs.writeFileSync(path.join(outDir, `${c.name}.abi.json`), JSON.stringify(art.abi, null, 2));
  fs.writeFileSync(path.join(outDir, `${c.name}.bytecode.txt`), "0x" + art.evm.bytecode.object);
  // legacy paths that deploy.cjs expects for the locker
  if (c.legacy) {
    fs.writeFileSync(path.join(outDir, "abi.json"), JSON.stringify(art.abi, null, 2));
    fs.writeFileSync(path.join(outDir, "bytecode.txt"), "0x" + art.evm.bytecode.object);
  }
  fs.writeFileSync(path.join(root, "web", "src", c.webAbi), JSON.stringify(art.abi, null, 2));
  console.log(`${c.name}: compiled OK — bytecode bytes:`, art.evm.bytecode.object.length / 2);
}
console.log("solc", solc.version());
