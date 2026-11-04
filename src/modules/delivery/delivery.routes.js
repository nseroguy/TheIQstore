const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { pool } = require('../../config/db');

// 1. PUBLIC: Track an order
router.get('/track/:trackingCode', async (req, res) => {
  try {
    const { trackingCode } = req.params;
    const query = `
      SELECT d.tracking_code, d.delivery_status, d.recipient_name, d.recipient_phone,
             d.shipping_address, d.notes, d.estimated_arrival, d.delivered_at,
             o.total_amount, o.id as order_id
      FROM deliveries d
      LEFT JOIN orders o ON d.order_id = o.id
      WHERE UPPER(d.tracking_code) = UPPER($1);
    `;
    const result = await pool.query(query, [trackingCode]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Tracking code not found' });
    }
    res.json({ success: true, tracking: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 2. CUSTOMER: Place a new confectionery order
router.post('/', async (req, res) => {
  const client = await pool.connect();
  try {
    const { recipient_name, recipient_phone, shipping_address, notes, total_amount } = req.body;
    await client.query('BEGIN');

    // Create Order
    const orderRes = await client.query(
      `INSERT INTO orders (total_amount, payment_status) VALUES ($1, 'paid') RETURNING id;`,
      [total_amount || 25.00]
    );
    const orderId = orderRes.rows[0].id;
    const trackingCode = 'IQ-B' + crypto.randomBytes(3).toString('hex').toUpperCase();

    // Create Delivery
    const deliveryRes = await client.query(
      `INSERT INTO deliveries 
        (order_id, recipient_name, recipient_phone, shipping_address, notes, tracking_code, delivery_status, estimated_arrival)
       VALUES ($1, $2, $3, $4, $5, $6, 'unassigned', NOW() + INTERVAL '45 minutes')
       RETURNING *;`,
      [orderId, recipient_name, recipient_phone, shipping_address, notes, trackingCode]
    );

    await client.query('COMMIT');
    res.status(201).json({ success: true, delivery: deliveryRes.rows[0] });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// 3. ADMIN / RIDER: Update shipment status
router.patch('/:trackingCode/status', async (req, res) => {
  try {
    const { trackingCode } = req.params;
    const { status, driver_name } = req.body;

    const query = `
      UPDATE deliveries 
      SET delivery_status = $1,
          delivered_at = CASE WHEN $1 = 'delivered' THEN NOW() ELSE delivered_at END,
          updated_at = NOW()
      WHERE UPPER(tracking_code) = UPPER($2)
      RETURNING *;
    `;
    const result = await pool.query(query, [status, trackingCode]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Order not found' });
    }
    res.json({ success: true, delivery: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;