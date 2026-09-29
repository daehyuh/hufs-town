import { generateKeyPairSync } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const subjectArg = process.argv.find((arg) => arg.startsWith("--subject="));
const subject = subjectArg?.slice("--subject=".length).trim();
if (!subject || !/^(mailto:[^\s@]+@[^\s@]+|https:\/\/[^\s]+)$/i.test(subject)) {
  console.error("Usage: node scripts/generate-vapid.mjs --subject=mailto:contact@example.com");
  process.exit(2);
}

const envPath = resolve(process.cwd(), ".env");
let contents = "";
try { contents = readFileSync(envPath, "utf8"); } catch (error) {
  if (error.code !== "ENOENT") throw error;
}

const names = ["TOWN_WEB_PUSH_PUBLIC_KEY", "TOWN_WEB_PUSH_PRIVATE_KEY", "TOWN_WEB_PUSH_SUBJECT"];
const values = new Map(names.map((name) => {
  const match = contents.match(new RegExp(`^${name}=(.*)$`, "m"));
  return [name, match?.[1]?.trim() ?? ""];
}));
const configured = names.filter((name) => values.get(name));
if (configured.length) {
  if (configured.length === names.length) {
    console.log("VAPID settings already exist in backend/.env; no values were changed or displayed.");
    process.exit(0);
  }
  console.error("VAPID settings are partially configured in backend/.env. Complete or clear all three values before generating a keypair.");
  process.exit(2);
}

const pair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const publicKey = pair.publicKey.export({ type: "spki", format: "der" }).toString("base64url");
const privateKey = pair.privateKey.export({ type: "pkcs8", format: "der" }).toString("base64url");
const generated = new Map([
  [names[0], publicKey],
  [names[1], privateKey],
  [names[2], subject],
]);
const lines = contents ? contents.replace(/\r?\n$/, "").split(/\r?\n/) : [];
for (const [name, value] of generated) {
  const index = lines.findIndex((line) => line.startsWith(`${name}=`));
  if (index >= 0) lines[index] = `${name}=${value}`;
  else lines.push(`${name}=${value}`);
}
writeFileSync(envPath, `${lines.join("\n")}\n`, { encoding: "utf8", mode: 0o600 });
console.log("Generated the VAPID keypair in backend/.env. The private key was not displayed.");
