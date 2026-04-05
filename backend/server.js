// backend/server.js
const express = require("express");
const cors = require("cors");
const path = require("path");
const bodyParser = require("body-parser");
const fs = require("fs");
const os = require("os");
const Database = require("better-sqlite3");

const app = express();
const PORT = process.env.PORT || 4000;
const HOST = process.env.HOST || "0.0.0.0";

app.use(cors());
app.use(bodyParser.json());

// ---------- SQLite SETUP ----------
const dataDir = path.join(__dirname, "..", "data");
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir);
}
const dbPath = path.join(dataDir, "ambulance.db");
const db = new Database(dbPath);
// ---------- HELPER: distance + ETA (AI-ish model) ----------
function toRad(v) {
  return (v * Math.PI) / 180;
}

// Haversine distance in km
function distanceKm(lat1, lon1, lat2, lon2) {
  const R = 6371; // km
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) *
      Math.cos(toRad(lat2)) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

// Estimate ETA from distance (km) assuming avg city speed ~25 km/h
function estimateEtaMinutes(km) {
  if (!km || !isFinite(km)) return 5;
  const minutes = (km / 25) * 60;
  return Math.max(2, Math.round(minutes));
}

async function geocodeLocation(location) {
  if (!location || typeof location !== "string") return null;
  const url = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(location)}&limit=1`;
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": "1min-ambulance-demo/1.0",
        "Accept-Language": "en"
      }
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (!Array.isArray(data) || !data.length) return null;
    return { lat: parseFloat(data[0].lat), lng: parseFloat(data[0].lon) };
  } catch (err) {
    console.warn("Hospital geocode failed", err.message || err);
    return null;
  }
}

function getHospitalCoordsByName(name) {
  const hospitalLocationCoordinates = {
    "City Multi-Speciality Hospital": { lat: 13.9360, lng: 75.5682 },
    "Govt General Hospital": { lat: 13.9338, lng: 75.5672 }
  };
  return hospitalLocationCoordinates[name] || { lat: 13.9350, lng: 75.5685 };
}

function attachHospitalCoords(booking) {
  if (!booking) return booking;
  if (booking.hospitalLat != null && booking.hospitalLng != null) return booking;
  const coords = getHospitalCoordsByName(booking.hospitalName);
  booking.hospitalLat = coords.lat;
  booking.hospitalLng = coords.lng;
  return booking;
}

// Create tables if not exist
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    phone TEXT,
    email TEXT NOT NULL UNIQUE,
    password TEXT,
    googleId TEXT
  );

  CREATE TABLE IF NOT EXISTS drivers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    password TEXT NOT NULL,
    vehicle TEXT NOT NULL,
    baseLocation TEXT NOT NULL,
    lat REAL,
    lng REAL
  );

  CREATE TABLE IF NOT EXISTS hospitals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    password TEXT NOT NULL,
    location TEXT NOT NULL,
    lat REAL,
    lng REAL
  );

  CREATE TABLE IF NOT EXISTS bookings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    userEmail TEXT NOT NULL,
    userName TEXT NOT NULL,
    userPhone TEXT,
    pickup TEXT NOT NULL,
    pickupLat REAL,
    pickupLng REAL,
    emergencyType TEXT NOT NULL,
    driverId INTEGER NOT NULL,
    driverName TEXT NOT NULL,
    driverEmail TEXT NOT NULL,
    driverVehicle TEXT NOT NULL,
    driverLocation TEXT NOT NULL,
    hospitalId INTEGER NOT NULL,
    hospitalName TEXT NOT NULL,
    hospitalEmail TEXT NOT NULL,
    hospitalLocation TEXT NOT NULL,
    hospitalLat REAL,
    hospitalLng REAL,
    eta INTEGER NOT NULL,
    status TEXT NOT NULL,
    driverNote TEXT DEFAULT '',
    createdAt DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS booking_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    bookingId INTEGER NOT NULL,
    driverId INTEGER NOT NULL,
    driverName TEXT NOT NULL,
    driverEmail TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    createdAt DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS admins (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    password TEXT NOT NULL,
    createdAt DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

const hospitalInfo = db.prepare("PRAGMA table_info(hospitals)").all();
const hospitalCols = hospitalInfo.map((col) => col.name);
if (!hospitalCols.includes("lat")) {
  db.prepare("ALTER TABLE hospitals ADD COLUMN lat REAL").run();
}
if (!hospitalCols.includes("lng")) {
  db.prepare("ALTER TABLE hospitals ADD COLUMN lng REAL").run();
}

const bookingInfo = db.prepare("PRAGMA table_info(bookings)").all();
const bookingCols = bookingInfo.map((col) => col.name);
if (!bookingCols.includes("hospitalLat")) {
  db.prepare("ALTER TABLE bookings ADD COLUMN hospitalLat REAL").run();
}
if (!bookingCols.includes("hospitalLng")) {
  db.prepare("ALTER TABLE bookings ADD COLUMN hospitalLng REAL").run();
}


// ==================== USER AUTH ====================

// EMAIL SIGNUP
app.post("/api/user/signup", (req, res) => {
  const { name, phone, email, password } = req.body;
  if (!name || !email || !password) {
    return res.status(400).json({ message: "Missing required fields" });
  }

  try {
    const existing = db.prepare("SELECT id FROM users WHERE email = ?").get(email);
    if (existing) {
      return res.status(400).json({ message: "Email already registered" });
    }

    const stmt = db.prepare(`
      INSERT INTO users (name, phone, email, password)
      VALUES (?, ?, ?, ?)
    `);
    const info = stmt.run(name, phone || "", email, password);

    const user = db.prepare("SELECT id, name, phone, email FROM users WHERE id = ?").get(info.lastInsertRowid);
    res.json({ message: "Signup success", user });
  } catch (err) {
    console.error("User signup error:", err);
    res.status(500).json({ message: "Server error" });
  }
});

// EMAIL LOGIN
app.post("/api/user/login", (req, res) => {
  const { email, password } = req.body;
  try {
    const user = db.prepare(
      "SELECT id, name, phone, email FROM users WHERE email = ? AND password = ?"
    ).get(email, password);

    if (!user) {
      return res.status(401).json({ message: "Invalid credentials" });
    }

    res.json({ message: "Login success", user });
  } catch (err) {
    console.error("User login error:", err);
    res.status(500).json({ message: "Server error" });
  }
});

// GOOGLE LOGIN (simple demo)
app.post("/api/user/google-login", (req, res) => {
  const { name, email, googleId } = req.body;
  if (!email || !googleId) {
    return res.status(400).json({ message: "Invalid payload" });
  }

  try {
    let user = db.prepare(
      "SELECT id, name, phone, email FROM users WHERE email = ?"
    ).get(email);

    if (!user) {
      const stmt = db.prepare(`
        INSERT INTO users (name, phone, email, password, googleId)
        VALUES (?, ?, ?, '', ?)
      `);
      const info = stmt.run(name || "Google User", "", email, googleId);
      user = db.prepare("SELECT id, name, phone, email FROM users WHERE id = ?").get(info.lastInsertRowid);
    }

    res.json({ message: "Google login success", user });
  } catch (err) {
    console.error("Google login error:", err);
    res.status(500).json({ message: "Server error" });
  }
});

// ==================== DRIVER API ====================

// DRIVER SIGNUP
app.post("/api/driver/signup", (req, res) => {
  const { name, email, password, vehicle, baseLocation } = req.body;
  if (!name || !email || !password || !vehicle || !baseLocation) {
    return res.status(400).json({ message: "Missing fields" });
  }

  try {
    const existing = db.prepare("SELECT id FROM drivers WHERE email = ?").get(email);
    if (existing) {
      return res.status(400).json({ message: "Driver already exists" });
    }

    const stmt = db.prepare(`
      INSERT INTO drivers (name, email, password, vehicle, baseLocation)
      VALUES (?, ?, ?, ?, ?)
    `);
    const info = stmt.run(name, email, password, vehicle, baseLocation);

    const driver = db.prepare(
      "SELECT id, name, email, vehicle, baseLocation, lat, lng FROM drivers WHERE id = ?"
    ).get(info.lastInsertRowid);

    res.json({ message: "Driver registered", driver });
  } catch (err) {
    console.error("Driver signup error:", err);
    res.status(500).json({ message: "Server error" });
  }
});

// DRIVER LOGIN
app.post("/api/driver/login", (req, res) => {
  const { email, password } = req.body;
  try {
    const driver = db.prepare(
      "SELECT id, name, email, vehicle, baseLocation, lat, lng FROM drivers WHERE email = ? AND password = ?"
    ).get(email, password);

    if (!driver) {
      return res.status(401).json({ message: "Invalid credentials" });
    }

    res.json({ message: "Login success", driver });
  } catch (err) {
    console.error("Driver login error:", err);
    res.status(500).json({ message: "Server error" });
  }
});

// UPDATE DRIVER GPS LOCATION
app.post("/api/driver/location", (req, res) => {
  const { email, lat, lng } = req.body;
  try {
    const driver = db.prepare("SELECT id FROM drivers WHERE email = ?").get(email);
    if (!driver) {
      return res.status(404).json({ message: "Driver not found" });
    }

    db.prepare("UPDATE drivers SET lat = ?, lng = ? WHERE email = ?").run(lat, lng, email);
    res.json({ message: "Location updated" });
  } catch (err) {
    console.error("Driver location error:", err);
    res.status(500).json({ message: "Server error" });
  }
});

// DRIVER BOOKINGS LIST
// DRIVER BOOKINGS LIST (with optional date & limit)
// DRIVER BOOKINGS LIST (with optional date & limit)
app.get("/api/driver/bookings", (req, res) => {
  const { email, date } = req.query;
  try {
    let sql = `
      SELECT br.*, b.*, d.lat AS driverLat, d.lng AS driverLng
      FROM booking_requests br
      JOIN bookings b ON b.id = br.bookingId
      LEFT JOIN drivers d ON d.email = br.driverEmail
      WHERE br.driverEmail = ?
        AND (br.status = 'pending' OR br.status = 'accepted')
    `;
    const params = [email];

    if (date) {
      sql += " AND DATE(b.createdAt) = DATE(?)";
      params.push(date);
    }

    sql += " ORDER BY b.createdAt DESC LIMIT 20";
    let rows = db.prepare(sql).all(...params);
    rows = rows.map((row) => attachHospitalCoords(row));
    res.json(rows);
  } catch (err) {
    console.error("Driver bookings error:", err);
    res.status(500).json({ message: "Server error" });
  }
});



// ==================== HOSPITAL API ====================

// HOSPITAL SIGNUP
app.post("/api/hospital/signup", async (req, res) => {
  const { name, email, password, location } = req.body;
  if (!name || !email || !password || !location) {
    return res.status(400).json({ message: "Missing fields" });
  }

  try {
    const existing = db.prepare("SELECT id FROM hospitals WHERE email = ?").get(email);
    if (existing) {
      return res.status(400).json({ message: "Hospital already exists" });
    }

    let lat = null;
    let lng = null;
    const coords = await geocodeLocation(location);
    if (coords) {
      lat = coords.lat;
      lng = coords.lng;
    }

    const stmt = db.prepare(`
      INSERT INTO hospitals (name, email, password, location, lat, lng)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    const info = stmt.run(name, email, password, location, lat, lng);

    const hospital = db.prepare(
      "SELECT id, name, email, location, lat, lng FROM hospitals WHERE id = ?"
    ).get(info.lastInsertRowid);

    res.json({ message: "Hospital registered", hospital });
  } catch (err) {
    console.error("Hospital signup error:", err);
    res.status(500).json({ message: "Server error" });
  }
});

// HOSPITAL LOGIN
app.post("/api/hospital/login", (req, res) => {
  const { email, password } = req.body;
  try {
    const hospital = db.prepare(
      "SELECT id, name, email, location FROM hospitals WHERE email = ? AND password = ?"
    ).get(email, password);

    if (!hospital) {
      return res.status(401).json({ message: "Invalid credentials" });
    }

    res.json({ message: "Login success", hospital });
  } catch (err) {
    console.error("Hospital login error:", err);
    res.status(500).json({ message: "Server error" });
  }
});

// HOSPITAL BOOKINGS LIST (with driver live location)
// HOSPITAL BOOKINGS LIST (with driver live location + optional date & limit)
// HOSPITAL BOOKINGS LIST (with driver live location + optional date & limit)
app.get("/api/hospital/bookings", (req, res) => {
  const { email, date } = req.query;
  try {
    let sql = `
      SELECT b.*,
             d.lat AS driverLat,
             d.lng AS driverLng
      FROM bookings b
      LEFT JOIN drivers d ON d.id = b.driverId
      WHERE b.hospitalEmail = ?
    `;
    const params = [email];

    if (date) {
      sql += " AND DATE(b.createdAt) = DATE(?)";
      params.push(date);
    }

    sql += " ORDER BY b.createdAt DESC LIMIT 20";

    let rows = db.prepare(sql).all(...params);
    rows = rows.map(attachHospitalCoords);
    res.json(rows);
  } catch (err) {
    console.error("Hospital bookings error:", err);
    res.status(500).json({ message: "Server error" });
  }
});



// ==================== BOOKING API ====================

// Health check endpoint for frontend connectivity tests
app.get("/api/health", (req, res) => {
  res.json({ ok: true, serverTime: new Date().toISOString() });
});

// CREATE BOOKING
// CREATE BOOKING (AI picks nearest driver using GPS if available)
app.post("/api/bookings", async (req, res) => {
  const {
    userEmail,
    userName,
    pickup,
    emergencyType,
    hospitalPref,
    pickupLat,
    pickupLng,
    userPhone,
  } = req.body;

  if (!userEmail || !userName || !pickup || !emergencyType) {
    return res.status(400).json({ message: "Missing booking fields" });
  }

  try {
    let allHospitals = db.prepare("SELECT * FROM hospitals").all();
    if (!allHospitals.length) {
      return res.status(400).json({ message: "No hospital registered yet" });
    }

    async function enrichHospitalCoord(hospital) {
      if (hospital.lat != null && hospital.lng != null) return hospital;
      const coords = await geocodeLocation(hospital.location);
      if (coords) {
        db.prepare("UPDATE hospitals SET lat = ?, lng = ? WHERE id = ?").run(coords.lat, coords.lng, hospital.id);
        hospital.lat = coords.lat;
        hospital.lng = coords.lng;
      }
      return hospital;
    }

    allHospitals = await Promise.all(allHospitals.map(enrichHospitalCoord));

    let hospital = allHospitals[0];
    if (hospitalPref && hospitalPref !== "auto") {
      const byName = db.prepare("SELECT * FROM hospitals WHERE name = ?").get(hospitalPref);
      if (byName) {
        hospital = byName;
      }
    } else if (pickupLat && pickupLng) {
      let nearestHospital = hospital;
      let bestHospitalDist = Infinity;
      allHospitals.forEach((h) => {
        if (h.lat != null && h.lng != null) {
          const dist = distanceKm(pickupLat, pickupLng, h.lat, h.lng);
          if (dist < bestHospitalDist) {
            bestHospitalDist = dist;
            nearestHospital = h;
          }
        }
      });
      hospital = nearestHospital;
    }

    // 2) Choose nearby drivers within a reasonable range
    const allDrivers = db.prepare("SELECT * FROM drivers").all();
    if (!allDrivers.length) {
      return res.status(400).json({ message: "No ambulance drivers registered" });
    }

    let chosenDriver = null;
    let candidateList = [];
    const MAX_DRIVER_RANGE_KM = 6;
    if (pickupLat && pickupLng) {
      const driverDistances = allDrivers
        .filter((d) => d.lat != null && d.lng != null)
        .map((d) => ({ driver: d, dist: distanceKm(pickupLat, pickupLng, d.lat, d.lng) }))
        .sort((a, b) => a.dist - b.dist);

      const nearbyDrivers = driverDistances.filter((item) => item.dist <= MAX_DRIVER_RANGE_KM);
      candidateList = nearbyDrivers.length ? nearbyDrivers : driverDistances;
      if (candidateList.length) {
        chosenDriver = candidateList[0].driver;
      }
    }

    if (!candidateList.length) {
      candidateList = allDrivers.map((d) => ({ driver: d, dist: 0 }));
    }

    if (!chosenDriver) {
      chosenDriver = candidateList[0].driver;
    }

    let eta = 5;
    if (pickupLat && pickupLng && chosenDriver.lat != null && chosenDriver.lng != null) {
      const dist = distanceKm(pickupLat, pickupLng, chosenDriver.lat, chosenDriver.lng);
      eta = estimateEtaMinutes(dist);
    }

    const stmt = db.prepare(`
      INSERT INTO bookings (
        userEmail, userName, pickup, pickupLat, pickupLng,
        emergencyType, driverId, driverName, driverEmail,
        driverVehicle, driverLocation,
        hospitalId, hospitalName, hospitalEmail, hospitalLocation, hospitalLat, hospitalLng,
        eta, status, driverNote, userPhone
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);


    const info = stmt.run(
      userEmail,
      userName,
      pickup,
      pickupLat || null,
      pickupLng || null,
      emergencyType,
      chosenDriver.id,
      chosenDriver.name,
      chosenDriver.email,
      chosenDriver.vehicle,
      chosenDriver.baseLocation,
      hospital.id,
      hospital.name,
      hospital.email,
      hospital.location,
      hospital.lat || null,
      hospital.lng || null,
      eta,
      "pending",
      "",
      userPhone || null
    );

    const booking = db.prepare("SELECT * FROM bookings WHERE id = ?").get(info.lastInsertRowid);
    const requestStmt = db.prepare(`
      INSERT INTO booking_requests (bookingId, driverId, driverName, driverEmail, status)
      VALUES (?, ?, ?, ?, ?)
    `);

    const requestDrivers = candidateList.map((item) => item.driver);
    requestDrivers.forEach((driver) => {
      requestStmt.run(
        booking.id,
        driver.id,
        driver.name,
        driver.email,
        "pending"
      );
    });

    attachHospitalCoords(booking);
    res.json(booking);
  } catch (err) {
    console.error("Create booking error:", err);
    res.status(500).json({ message: "Server error" });
  }
});


// USER BOOKINGS + driver GPS
// USER BOOKINGS + driver GPS (limit last 10)
app.get("/api/bookings/by-user", (req, res) => {
  const { email } = req.query;
  try {
    const rows = db.prepare(`
      SELECT b.*,
             d.lat AS driverLat,
             d.lng AS driverLng
      FROM bookings b
      LEFT JOIN drivers d ON d.id = b.driverId
      WHERE b.userEmail = ?
      ORDER BY b.createdAt DESC
      LIMIT 10
    `).all(email);

    res.json(rows);
  } catch (err) {
    console.error("User bookings error:", err);
    res.status(500).json({ message: "Server error" });
  }
});


// DRIVER ACCEPT / UPDATE BOOKING
app.post("/api/bookings/:id/accept", (req, res) => {
  const { id } = req.params;
  const { driverNote, driverEmail } = req.body;

  try {
    const request = db.prepare(
      "SELECT * FROM booking_requests WHERE bookingId = ? AND driverEmail = ?"
    ).get(id, driverEmail);
    if (!request || request.status !== "pending") {
      return res.status(400).json({ message: "No pending request found for this driver" });
    }

    const booking = db.prepare("SELECT * FROM bookings WHERE id = ?").get(id);
    if (!booking) {
      return res.status(404).json({ message: "Booking not found" });
    }

    const driver = db.prepare("SELECT * FROM drivers WHERE email = ?").get(driverEmail);
    if (!driver) {
      return res.status(404).json({ message: "Driver not found" });
    }

    const updateBooking = db.prepare(`
      UPDATE bookings SET status = ?, driverNote = ?, driverId = ?, driverName = ?, driverEmail = ?, driverVehicle = ?, driverLocation = ?
      WHERE id = ?
    `);
    updateBooking.run(
      "accepted",
      driverNote || "",
      driver.id,
      driver.name,
      driver.email,
      driver.vehicle,
      driver.baseLocation,
      id
    );

    db.prepare(
      "UPDATE booking_requests SET status = ? WHERE bookingId = ? AND driverEmail = ?"
    ).run("accepted", id, driverEmail);

    db.prepare(
      "UPDATE booking_requests SET status = ? WHERE bookingId = ? AND driverEmail != ?"
    ).run("cancelled", id, driverEmail);

    const updated = db.prepare("SELECT * FROM bookings WHERE id = ?").get(id);
    res.json(updated);
  } catch (err) {
    console.error("Accept booking error:", err);
    res.status(500).json({ message: "Server error" });
  }
});

// DRIVER REJECT BOOKING
app.post("/api/bookings/:id/driver-reject", (req, res) => {
  const { id } = req.params;
  const { driverEmail, rejectionReason } = req.body;

  try {
    const booking = db.prepare("SELECT * FROM bookings WHERE id = ?").get(id);
    if (!booking) {
      return res.status(404).json({ message: "Booking not found" });
    }

    // Update booking status to rejected by driver
    db.prepare(
      "UPDATE bookings SET status = ? WHERE id = ?"
    ).run("driver-rejected", id);

    // Update booking request
    db.prepare(
      "UPDATE booking_requests SET status = ? WHERE bookingId = ? AND driverEmail = ?"
    ).run("rejected", id, driverEmail);

    const updated = db.prepare("SELECT * FROM bookings WHERE id = ?").get(id);
    res.json({ message: "Booking rejected by driver", booking: updated });
  } catch (err) {
    console.error("Driver reject error:", err);
    res.status(500).json({ message: "Server error" });
  }
});

// HOSPITAL REJECT BOOKING (only after accepting)
app.post("/api/bookings/:id/hospital-reject", (req, res) => {
  const { id } = req.params;
  const { hospitalEmail, rejectionReason } = req.body;

  try {
    const booking = db.prepare("SELECT * FROM bookings WHERE id = ?").get(id);
    if (!booking) {
      return res.status(404).json({ message: "Booking not found" });
    }

    if (booking.status !== "accepted") {
      return res.status(400).json({ message: "Can only reject after accepting" });
    }

    // Update booking status to rejected by hospital
    db.prepare(
      "UPDATE bookings SET status = ? WHERE id = ?"
    ).run("hospital-rejected", id);

    const updated = db.prepare("SELECT * FROM bookings WHERE id = ?").get(id);
    res.json({ message: "Booking rejected by hospital", booking: updated });
  } catch (err) {
    console.error("Hospital reject error:", err);
    res.status(500).json({ message: "Server error" });
  }
});

// USER REJECT DRIVER ARRIVAL
app.post("/api/bookings/:id/user-reject", (req, res) => {
  const { id } = req.params;
  const { userEmail, rejectionReason } = req.body;

  try {
    const booking = db.prepare("SELECT * FROM bookings WHERE id = ?").get(id);
    if (!booking) {
      return res.status(404).json({ message: "Booking not found" });
    }

    // Update booking status to rejected by user
    db.prepare(
      "UPDATE bookings SET status = ? WHERE id = ?"
    ).run("user-rejected", id);

    const updated = db.prepare("SELECT * FROM bookings WHERE id = ?").get(id);
    res.json({ message: "Booking rejected by user", booking: updated });
  } catch (err) {
    console.error("User reject error:", err);
    res.status(500).json({ message: "Server error" });
  }
});

// ==================== ADMIN API ====================

// ADMIN SIGNUP
app.post("/api/admin/signup", (req, res) => {
  const { name, email, password } = req.body;
  if (!name || !email || !password) {
    return res.status(400).json({ message: "Missing required fields" });
  }

  try {
    const existing = db.prepare("SELECT id FROM admins WHERE email = ?").get(email);
    if (existing) {
      return res.status(400).json({ message: "Admin already exists" });
    }

    const stmt = db.prepare(`
      INSERT INTO admins (name, email, password)
      VALUES (?, ?, ?)
    `);
    const info = stmt.run(name, email, password);

    const admin = db.prepare("SELECT id, name, email FROM admins WHERE id = ?").get(info.lastInsertRowid);
    res.json({ message: "Admin registered", admin });
  } catch (err) {
    console.error("Admin signup error:", err);
    res.status(500).json({ message: "Server error" });
  }
});

// ADMIN LOGIN
app.post("/api/admin/login", (req, res) => {
  const { email, password } = req.body;
  try {
    const admin = db.prepare(
      "SELECT id, name, email FROM admins WHERE email = ? AND password = ?"
    ).get(email, password);

    if (!admin) {
      return res.status(401).json({ message: "Invalid credentials" });
    }

    res.json({ message: "Login success", admin });
  } catch (err) {
    console.error("Admin login error:", err);
    res.status(500).json({ message: "Server error" });
  }
});

// GET ALL BOOKINGS FOR ADMIN DASHBOARD
app.get("/api/admin/bookings", (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT * FROM bookings
      ORDER BY createdAt DESC
    `).all();

    res.json(rows);
  } catch (err) {
    console.error("Admin bookings error:", err);
    res.status(500).json({ message: "Server error" });
  }
});

// GET ANALYTICS - DAILY REQUESTS
app.get("/api/admin/analytics/daily", (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT DATE(createdAt) as date, 
             COUNT(*) as total,
             SUM(CASE WHEN status = 'accepted' THEN 1 ELSE 0 END) as accepted,
             SUM(CASE WHEN status LIKE '%rejected' THEN 1 ELSE 0 END) as rejected
      FROM bookings
      WHERE createdAt >= date('now', '-30 days')
      GROUP BY DATE(createdAt)
      ORDER BY date DESC
    `).all();

    res.json(rows);
  } catch (err) {
    console.error("Daily analytics error:", err);
    res.status(500).json({ message: "Server error" });
  }
});

// GET ANALYTICS - MONTHLY REQUESTS
app.get("/api/admin/analytics/monthly", (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT strftime('%Y-%m', createdAt) as month, 
             COUNT(*) as total,
             SUM(CASE WHEN status = 'accepted' THEN 1 ELSE 0 END) as accepted,
             SUM(CASE WHEN status LIKE '%rejected' THEN 1 ELSE 0 END) as rejected
      FROM bookings
      GROUP BY strftime('%Y-%m', createdAt)
      ORDER BY month DESC
    `).all();

    res.json(rows);
  } catch (err) {
    console.error("Monthly analytics error:", err);
    res.status(500).json({ message: "Server error" });
  }
});

// GET HOSPITAL STATISTICS
app.get("/api/admin/analytics/hospitals", (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT hospitalName, COUNT(*) as total,
             SUM(CASE WHEN status = 'accepted' THEN 1 ELSE 0 END) as accepted,
             SUM(CASE WHEN status LIKE '%rejected' THEN 1 ELSE 0 END) as rejected
      FROM bookings
      GROUP BY hospitalName
      ORDER BY total DESC
    `).all();

    res.json(rows);
  } catch (err) {
    console.error("Hospital analytics error:", err);
    res.status(500).json({ message: "Server error" });
  }
});

// GET DRIVER STATISTICS
app.get("/api/admin/analytics/drivers", (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT driverName, driverEmail, COUNT(*) as total,
             SUM(CASE WHEN status = 'accepted' THEN 1 ELSE 0 END) as accepted,
             SUM(CASE WHEN status LIKE '%rejected' THEN 1 ELSE 0 END) as rejected
      FROM bookings
      GROUP BY driverEmail
      ORDER BY total DESC
    `).all();

    res.json(rows);
  } catch (err) {
    console.error("Driver analytics error:", err);
    res.status(500).json({ message: "Server error" });
  }
});

// GET DRIVER STATISTICS FOR SPECIFIC DATE RANGE
app.get("/api/admin/analytics/driver/:email", (req, res) => {
  const { email } = req.params;
  try {
    const rows = db.prepare(`
      SELECT DATE(createdAt) as date, 
             COUNT(*) as total,
             SUM(CASE WHEN status = 'accepted' THEN 1 ELSE 0 END) as accepted,
             SUM(CASE WHEN status LIKE '%rejected' THEN 1 ELSE 0 END) as rejected
      FROM bookings
      WHERE driverEmail = ?
      GROUP BY DATE(createdAt)
      ORDER BY date DESC
      LIMIT 30
    `).all(email);

    res.json(rows);
  } catch (err) {
    console.error("Driver detail analytics error:", err);
    res.status(500).json({ message: "Server error" });
  }
});

// GET DASHBOARD SUMMARY
app.get("/api/admin/analytics/summary", (req, res) => {
  try {
    const totalBookings = db.prepare("SELECT COUNT(*) as count FROM bookings").get();
    const acceptedBookings = db.prepare("SELECT COUNT(*) as count FROM bookings WHERE status = 'accepted'").get();
    const rejectedBookings = db.prepare("SELECT COUNT(*) as count FROM bookings WHERE status LIKE '%rejected'").get();
    const totalDrivers = db.prepare("SELECT COUNT(*) as count FROM drivers").get();
    const totalHospitals = db.prepare("SELECT COUNT(*) as count FROM hospitals").get();
    const totalUsers = db.prepare("SELECT COUNT(*) as count FROM users").get();

    res.json({
      totalBookings: totalBookings.count,
      acceptedBookings: acceptedBookings.count,
      rejectedBookings: rejectedBookings.count,
      totalDrivers: totalDrivers.count,
      totalHospitals: totalHospitals.count,
      totalUsers: totalUsers.count
    });
  } catch (err) {
    console.error("Summary analytics error:", err);
    res.status(500).json({ message: "Server error" });
  }
});

// ---------- SERVE FRONTEND (AFTER ALL API ROUTES) ----------
app.use(express.static(path.join(__dirname, "..", "public")));

// ---------- START SERVER ----------
function getLocalIP() {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name]) {
      if (iface.family === "IPv4" && !iface.internal) {
        return iface.address;
      }
    }
  }
  return "localhost";
}

app.listen(PORT, HOST, () => {
  const localIP = getLocalIP();
  console.log(`Server running with SQLite DB on http://localhost:${PORT}`);
  if (HOST === "0.0.0.0" || HOST === "::" || HOST === "") {
    console.log(`Accessible on your network at http://${localIP}:${PORT}`);
  } else {
    console.log(`Listening on ${HOST}:${PORT}`);
  }
  console.log(`If you want to use ngrok for mobile HTTPS access, run: ngrok http ${PORT}`);
});
