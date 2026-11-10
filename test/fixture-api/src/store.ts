import crypto from "node:crypto";
import config from "./config/index";
export const USERS = [
  { _id: "aaaaaaaaaaaaaaaaaaaaaaa1", identifier: "merchant-a@qa.test", password: "QaPass#1", role: "MERCHANT", device: "merchant" },
  { _id: "bbbbbbbbbbbbbbbbbbbbbbb2", identifier: "merchant-b@qa.test", password: "QaPass#2", role: "MERCHANT", device: "merchant" },
  { _id: "ccccccccccccccccccccccc3", identifier: "customer@qa.test", password: "QaPass#3", role: "USER", device: "user" },
  { _id: "ddddddddddddddddddddddd4", identifier: "admin@qa.test", password: "QaPass#4", role: "SUPER_ADMIN", device: "admin" },
];
export const PROMOTIONS = [
  { _id: "5f0000000000000000000a01", merchantId: USERS[0]._id, title: "A: 10% off" },
  { _id: "5f0000000000000000000a02", merchantId: USERS[0]._id, title: "A: free coffee" },
  { _id: "5f0000000000000000000b01", merchantId: USERS[1]._id, title: "B: 2-for-1" },
];
export const CUSTOMERS = [
  { _id: "6f0000000000000000000a01", merchantId: USERS[0]._id, name: "Ali (A)" },
  { _id: "6f0000000000000000000b01", merchantId: USERS[1]._id, name: "Sara (B)" },
];
const sign = (payload: string) => crypto.createHmac("sha256", config.jwt_secret).update(payload).digest("base64url");
export const issueToken = (u: (typeof USERS)[number]) => {
  const p = Buffer.from(JSON.stringify({ id: u._id, role: u.role })).toString("base64url");
  return `${p}.${sign(p)}`;
};
export const readToken = (t: string) => {
  const [p, s] = t.split(".");
  if (!p || !s || sign(p) !== s) return null;
  try { return JSON.parse(Buffer.from(p, "base64url").toString()) as { id: string; role: string }; } catch { return null; }
};
