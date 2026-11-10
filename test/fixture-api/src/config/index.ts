export default {
  port: Number(process.env.PORT || 4010),
  database_url: process.env.DATABASE_URL, // planted bug: .env.example says MONGODB_URI
  jwt_secret: process.env.JWT_SECRET || "fixture-signing-key",
  client_url: process.env.CLIENT_URL,
};
