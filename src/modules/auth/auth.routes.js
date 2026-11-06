const express = require('express');
const router = express.Router();
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { pool } = require('../../config/db');
const { requireAuth, requireRole } = require('../../middleware/auth.middleware');

const JWT_SECRET = process.env.JWT_SECRET || 'secret';

const createToken = (user) => {
  return jwt.sign(
    { id: user.id, email: user.email, role: user.role, name: user.name },
    JWT_SECRET,
    { expiresIn: '7d' }
  );
};

// 1. Customer Signup
router.post('/customer/signup', async (req, res) => {
  try {
    const { name, email, password, phone } = req.body;
    if (!name || !email || !password) {
      return res.status(400).json({ error: 'Name, email, and password required' });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const result = await pool.query(
      `INSERT INTO users (name, email, password_hash, role, phone)
       VALUES ($1, $2, $3, 'customer', $4)
       RETURNING id, name, email, role, phone;`,
      [name, email.toLowerCase().trim(), passwordHash, phone || null]
    );

    const user = result.rows[0];
    const token = createToken(user);
    res.status(201).json({ success: true, token, user });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(400).json({ error: 'An account with this email already exists' });
    }
    res.status(500).json({ error: err.message });
  }
});

// Generic Role Login
async function handleRoleLogin(req, res, expectedRoles) {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password required' });
    }

    const result = await pool.query(
      `SELECT id, name, email, password_hash, role, phone, vehicle_info, is_active FROM users WHERE LOWER(email) = LOWER($1)`,
      [email.trim()]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const user = result.rows[0];
    if (user.is_active === false) {
      return res.status(403).json({ error: 'This account has been deactivated by administration.' });
    }

    const validPassword = await bcrypt.compare(password, user.password_hash);
    if (!validPassword) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    if (!expectedRoles.includes(user.role)) {
      return res.status(403).json({ 
        error: `Access denied. Role '${user.role}' cannot authenticate through this portal.` 
      });
    }

    const token = createToken(user);
    return res.json({
      success: true,
      token,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
        vehicle_info: user.vehicle_info || null
      }
    });
  } catch (err) {
    console.error('Role login error:', err);
    return res.status(500).json({ error: err.message || 'Internal server error' });
  }
}

router.post('/customer/login', (req, res) => handleRoleLogin(req, res, ['customer']));
router.post('/staff/login', (req, res) => handleRoleLogin(req, res, ['staff', 'admin']));
router.post('/rider/login', (req, res) => handleRoleLogin(req, res, ['driver']));
router.post('/admin/login', (req, res) => handleRoleLogin(req, res, ['admin']));

router.get('/me', requireAuth, (req, res) => {
  res.json({ success: true, user: req.user });
});

// Admin: Auto-Provision Employee with Domain Cleansing
router.post('/admin/create-employee', requireAuth, requireRole(['admin']), async (req, res) => {
  try {
    const { name, sudo_name, password, role, phone, vehicle_info } = req.body;

    if (!['staff', 'driver'].includes(role)) {
      return res.status(400).json({ error: "Only 'staff' or 'driver' accounts can be created" });
    }

    if (!name || !sudo_name || !password) {
      return res.status(400).json({ error: 'Legal name, pseudo name/username, and password are required' });
    }

    // Strip out @theiqstore.com, email domains, spaces, and punctuation to prevent admin.theiqstore.com@theiqstore.com
    const cleanSudo = sudo_name
      .trim()
      .toLowerCase()
      .replace(/@.*$/, '')                         // Remove anything starting at @
      .replace(/\.?theiqstore\.com/gi, '')        // Remove accidental theiqstore.com
      .replace(/[^a-z0-9.]/g, '.')                // Convert symbols to dots
      .replace(/\.+/g, '.')                       // Collapse repeated dots
      .replace(/^\.|\.$/g, '');                   // Trim leading/trailing dots

    if (!cleanSudo) {
      return res.status(400).json({ error: 'Please enter a valid alphanumeric username' });
    }

    const generatedEmail = `${cleanSudo}@theiqstore.com`;

    const passwordHash = await bcrypt.hash(password, 10);
    const result = await pool.query(
      `INSERT INTO users (name, email, password_hash, role, phone, vehicle_info, is_active)
       VALUES ($1, $2, $3, $4, $5, $6, true)
       RETURNING id, name, email, role, phone, vehicle_info, is_active, created_at;`,
      [name.trim(), generatedEmail, passwordHash, role, phone || null, role === 'driver' ? (vehicle_info || 'Standard Box Bike') : null]
    );

    res.status(201).json({
      success: true,
      message: `${role === 'driver' ? 'Rider' : 'Staff'} registered! Sign-in email: ${generatedEmail}`,
      generated_email: generatedEmail,
      raw_password: password,
      employee: result.rows[0]
    });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(400).json({ error: `The login handle '${req.body.sudo_name}' is already registered.` });
    }
    console.error('Create employee error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Admin: List All Internal Employees (Staff & Riders)
router.get('/admin/employees', requireAuth, requireRole(['admin']), async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, name, email, role, phone, vehicle_info, is_active, created_at
       FROM users 
       WHERE role IN ('driver', 'staff')
       ORDER BY created_at DESC`
    );
    res.json({ success: true, employees: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Admin: Toggle Employee Active Status
router.patch('/admin/employees/:id/toggle-status', requireAuth, requireRole(['admin']), async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query(
      `UPDATE users 
       SET is_active = NOT COALESCE(is_active, true) 
       WHERE id = $1::uuid AND role IN ('driver', 'staff')
       RETURNING id, name, email, role, is_active;`,
      [id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Employee not found' });
    res.json({ success: true, employee: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Dispatch / Admin: List active riders for assignment dropdowns
router.get('/riders', requireAuth, requireRole(['admin', 'staff']), async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, name, phone, vehicle_info FROM users WHERE role = 'driver' AND is_active = true ORDER BY name ASC`
    );
    res.json({ success: true, riders: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
