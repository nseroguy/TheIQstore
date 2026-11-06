const express = require('express');
const router = express.Router();
const bcrypt = require('bcrypt');
const { pool } = require('../../config/db');
const { requireAuth, requireRole } = require('../../middleware/auth.middleware');
const { logAudit } = require('../../utils/auditLogger');

// All routes require Admin privileges
router.use(requireAuth, requireRole(['admin']));

// ==========================================
// 1. PRODUCTS CRUD
// ==========================================

// Get All Products (including out-of-stock / hidden)
router.get('/products', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM products ORDER BY created_at DESC');
    res.json({ success: true, products: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Create Product
router.post('/products', async (req, res) => {
  try {
    const { title, description, price, stock, image_url, category } = req.body;
    if (!title || price === undefined) {
      return res.status(400).json({ error: 'Product title and price are required' });
    }

    const result = await pool.query(
      `INSERT INTO products (title, description, price, stock, image_url, category, is_available)
       VALUES ($1, $2, $3, $4, $5, $6, true)
       RETURNING *;`,
      [title, description || '', Number(price), Number(stock) || 0, image_url || null, category || 'Cakes']
    );

    const product = result.rows[0];
    await logAudit({
      req,
      action: 'CREATE_PRODUCT',
      entityType: 'product',
      entityId: product.id,
      details: { title, price, stock }
    });

    res.status(201).json({ success: true, product });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update Product
router.put('/products/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { title, description, price, stock, image_url, category, is_available } = req.body;

    const result = await pool.query(
      `UPDATE products
       SET title = COALESCE($1, title),
           description = COALESCE($2, description),
           price = COALESCE($3, price),
           stock = COALESCE($4, stock),
           image_url = COALESCE($5, image_url),
           category = COALESCE($6, category),
           is_available = COALESCE($7, is_available)
       WHERE id = $8::uuid
       RETURNING *;`,
      [title, description, price, stock, image_url, category, is_available, id]
    );

    if (result.rows.length === 0) return res.status(404).json({ error: 'Product not found' });
    const product = result.rows[0];

    await logAudit({
      req,
      action: 'UPDATE_PRODUCT',
      entityType: 'product',
      entityId: product.id,
      details: req.body
    });

    res.json({ success: true, product });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete Product
router.delete('/products/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query(`DELETE FROM products WHERE id = $1::uuid RETURNING id, title;`, [id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Product not found' });

    await logAudit({
      req,
      action: 'DELETE_PRODUCT',
      entityType: 'product',
      entityId: id,
      details: { deletedProduct: result.rows[0] }
    });

    res.json({ success: true, message: 'Product removed successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// 2. USERS CRUD (Staff, Riders, Customers)
// ==========================================

// Get All Users Filtered by Role
router.get('/users', async (req, res) => {
  try {
    const { role } = req.query;
    let query = `SELECT id, name, email, role, phone, vehicle_info, is_active, created_at FROM users`;
    const params = [];

    if (role) {
      query += ` WHERE role = $1`;
      params.push(role);
    }
    query += ` ORDER BY created_at DESC;`;

    const result = await pool.query(query, params);
    res.json({ success: true, users: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update User (Edit Name, Phone, Vehicle, or Reset Password)
router.put('/users/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { name, phone, vehicle_info, password, is_active } = req.body;

    let passwordHash = null;
    if (password && password.trim().length > 0) {
      passwordHash = await bcrypt.hash(password.trim(), 10);
    }

    const query = `
      UPDATE users
      SET name = COALESCE($1, name),
          phone = COALESCE($2, phone),
          vehicle_info = COALESCE($3, vehicle_info),
          is_active = COALESCE($4, is_active),
          password_hash = COALESCE($5, password_hash)
      WHERE id = $6::uuid
      RETURNING id, name, email, role, phone, vehicle_info, is_active, created_at;
    `;

    const result = await pool.query(query, [name, phone, vehicle_info, is_active, passwordHash, id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'User not found' });

    const updatedUser = result.rows[0];
    await logAudit({
      req,
      action: 'UPDATE_USER',
      entityType: 'user',
      entityId: id,
      details: { name, phone, vehicle_info, is_active, passwordChanged: !!passwordHash }
    });

    res.json({ success: true, user: updatedUser });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete User
router.delete('/users/:id', async (req, res) => {
  try {
    const { id } = req.params;

    // Prevent deleting oneself
    if (req.user.id === id) {
      return res.status(400).json({ error: 'You cannot delete your own admin account' });
    }

    const result = await pool.query(`DELETE FROM users WHERE id = $1::uuid RETURNING id, name, email, role;`, [id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'User not found' });

    await logAudit({
      req,
      action: 'DELETE_USER',
      entityType: 'user',
      entityId: id,
      details: { deletedUser: result.rows[0] }
    });

    res.json({ success: true, message: 'User deleted successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// 3. ACCOUNTS & FINANCIAL BALANCES
// ==========================================
router.get('/accounts', async (req, res) => {
  try {
    const statsQuery = `
      SELECT 
        COUNT(id) as total_orders,
        COALESCE(SUM(total_amount), 0) as gross_revenue,
        COALESCE(SUM(CASE WHEN payment_method = 'cash' THEN total_amount ELSE 0 END), 0) as cash_collected,
        COALESCE(SUM(CASE WHEN payment_method = 'mobile_money' THEN total_amount ELSE 0 END), 0) as momo_collected,
        COALESCE(SUM(CASE WHEN payment_status = 'paid' OR payment_status = 'mobile_money_confirmed' THEN total_amount ELSE 0 END), 0) as settled_revenue,
        COALESCE(SUM(CASE WHEN payment_status = 'pending_cash_on_delivery' THEN total_amount ELSE 0 END), 0) as pending_settlement
      FROM orders;
    `;
    const breakdownRes = await pool.query(statsQuery);

    const recentTransactions = await pool.query(`
      SELECT o.id, o.total_amount, o.payment_method, o.payment_status, o.created_at,
             u.name as customer_name, d.tracking_code, d.delivery_status
      FROM orders o
      LEFT JOIN users u ON o.customer_id = u.id
      LEFT JOIN deliveries d ON d.order_id = o.id
      ORDER BY o.created_at DESC
      LIMIT 25;
    `);

    res.json({
      success: true,
      summary: breakdownRes.rows[0],
      transactions: recentTransactions.rows
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// 4. AUDIT TRAIL
// ==========================================
router.get('/audit-trail', async (req, res) => {
  try {
    const { limit = 50 } = req.query;
    const result = await pool.query(
      `SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT $1`,
      [Number(limit)]
    );
    res.json({ success: true, logs: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
