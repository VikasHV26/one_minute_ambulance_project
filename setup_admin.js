const Database = require('better-sqlite3');
const db = new Database('data/ambulance.db');

// Insert test admin
db.prepare('INSERT INTO admins (name, email, password) VALUES (?, ?, ?)').run(
  'Admin User',
  'admin@hospital.com',
  'admin123'
);

// Verify
const admins = db.prepare('SELECT * FROM admins').all();
console.log('Admins in database:');
console.log(JSON.stringify(admins, null, 2));

db.close();
