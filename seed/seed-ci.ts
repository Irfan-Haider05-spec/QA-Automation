/**
 * Seeds QA accounts and a little tenant data into a THROWAWAY MongoDB used by
 * the PR workflow. Never point this at staging or production: it refuses to
 * run unless the host is local (localhost / 127.0.0.1 / mongo) or --force is given.
 *
 *   npx tsx seed/seed-ci.ts --uri mongodb://localhost:27017/mlitech_qa
 *
 * Creates (idempotent, upsert by email):
 *   merchantA, merchantB  MERCHANT, verified, active
 *   customer              USER
 *   one ADMIN_MERCHANT sub-user under each merchant
 *   two promotions per merchant
 * The SUPER_ADMIN is created by the backend itself on boot from ADMIN_EMAIL /
 * ADMIN_PASSWORD, so the workflow sets those to the QA admin credentials.
 * Field names follow src/app/modules/user/user.model.ts and
 * src/app/modules/merchant/promotionMerchant/promotionMerchant.model.ts.
 */
import { parseArgs } from "node:util";
import { MongoClient, ObjectId } from "mongodb";
import bcrypt from "bcryptjs";

const { values } = parseArgs({ options: { uri: { type: "string" }, force: { type: "boolean", default: false } } });
const uri = values.uri ?? process.env.DATABASE_URL;
if (!uri) throw new Error("--uri or DATABASE_URL is required");
const host = uri.replace(/^mongodb(\+srv)?:\/\//, "").replace(/^[^@]*@/, "").split(/[/:?,]/)[0];
if (!["localhost", "127.0.0.1", "mongo", "mongodb"].includes(host) && !values.force) {
  throw new Error(`Refusing to seed non-local host "${host}". This script is for throwaway CI databases only.`);
}

const need = (k: string) => {
  const v = process.env[k];
  if (!v) throw new Error(`${k} is not set`);
  return v;
};

async function main() {
  const client = await MongoClient.connect(uri!);
  const db = client.db();
  const users = db.collection("users");
  const promos = db.collection("promotionmerchants");
  const rounds = Number(process.env.BCRYPT_SALT_ROUNDS ?? 10);
  const now = new Date();
  const rid = () => `QA${Math.random().toString(36).slice(2, 10).toUpperCase()}`;

  async function upsertUser(email: string, password: string, extra: Record<string, unknown>) {
    const existing = await users.findOne({ email });
    const _id = existing?._id ?? new ObjectId();
    await users.updateOne(
      { _id },
      {
        $set: {
          email, password: await bcrypt.hash(password, rounds), verified: true, status: "active",
          isDeleted: false, authProviders: ["local"], updatedAt: now, ...extra,
        },
        $setOnInsert: { referenceId: rid(), customUserId: rid(), createdAt: now },
      },
      { upsert: true },
    );
    return _id;
  }

  const a = await upsertUser(need("QA_MERCHANT_A_ID"), need("QA_MERCHANT_A_PASS"), { firstName: "QA Merchant A", businessName: "QA Shop A", role: "MERCHANT", merchantId: null, subscription: "active", paymentStatus: "paid", approveStatus: "approved" });
  const b = await upsertUser(need("QA_MERCHANT_B_ID"), need("QA_MERCHANT_B_PASS"), { firstName: "QA Merchant B", businessName: "QA Shop B", role: "MERCHANT", merchantId: null, subscription: "active", paymentStatus: "paid", approveStatus: "approved" });
  await upsertUser(need("QA_CUSTOMER_ID"), need("QA_CUSTOMER_PASS"), { firstName: "QA Customer", role: "USER" });
  await upsertUser("qa-staff-a@qa.invalid", "QaStaffA#2026", { firstName: "QA Staff A", role: "ADMIN_MERCHANT", merchantId: a, createdBy: a });
  await upsertUser("qa-staff-b@qa.invalid", "QaStaffB#2026", { firstName: "QA Staff B", role: "ADMIN_MERCHANT", merchantId: b, createdBy: b });

  const inAMonth = new Date(Date.now() + 30 * 86400000);
  for (const [merchantId, label] of [[a, "A"], [b, "B"]] as const) {
    for (const n of [1, 2]) {
      await promos.updateOne(
        { cardId: `QA-${label}-${n}` },
        {
          $set: {
            name: `QA promo ${label}${n}`, customerSegment: "all_customer", discountPercentage: 10 * n, promotionType: "seasonal",
            startDate: now, endDate: inAMonth, availableDays: ["all"], status: "active", merchantId, grossValue: 100, updatedAt: now,
          },
          $setOnInsert: { createdAt: now },
        },
        { upsert: true },
      );
    }
  }
  console.log(`Seeded QA data into ${host}: merchants ${a} / ${b}, customer, 2 staff users, 4 promotions`);
  await client.close();
}

main().catch((e) => { console.error(e.message ?? e); process.exit(1); });
