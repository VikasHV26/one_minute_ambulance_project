// Add userPhone column to bookings table if it doesn't exist
const Database = require("better-sqlite3");
const path = require("path");
const fs = require("fs");

const dataDir = path.join(__dirname, "..", "data");
const dbPath = path.join(dataDir, "ambulance.db");

const db = new Database(dbPath);

try {
  // Check if userPhone column exists
  const result = db.prepare("PRAGMA table_info(bookings)").all();
  const hasUserPhoneColumn = result.some(col => col.name === 'userPhone');

  if (!hasUserPhoneColumn) {
    console.log("Adding userPhone column to bookings table...");
    db.exec("ALTER TABLE bookings ADD COLUMN userPhone TEXT");
    console.log("✅ userPhone column added successfully!");
  } else {
    console.log("✅ userPhone column already exists!");
  }
} catch (err) {
  console.error("❌ Error:", err.message);
}

db.close();
