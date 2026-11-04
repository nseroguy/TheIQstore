require('dotenv').config();
const bcrypt = require('bcrypt');
const { pool } = require('../src/config/db');

async function seed() {
  console.log('Seeding initial store and delivery data...');
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // 1. Create Users
    const passwordHash = await bcrypt.hash('password123', 10);

    const userRes = await client.query(`
      INSERT INTO users (name, email, password_hash, role, phone)
      VALUES 
        ('Admin User', 'admin@theiqstore.com', $1, 'admin', '+256700000001'),
        ('John Courier', 'driver@theiqstore.com', $1, 'driver', '+256700000002'),
        ('Alice Customer', 'alice@example.com', $1, 'customer', '+256700000003')
      ON CONFLICT (email) DO NOTHING
      RETURNING id, role;
    `, [passwordHash]);

    // Query user IDs
    const users = (await client.query('SELECT id, email, role FROM users')).rows;
    const customer = users.find(u => u.role === 'customer');
    const driver = users.find(u => u.role === 'driver');

    // 2. Create Products
    await client.query(`
      INSERT INTO products (title, description, price, stock, image_url)
      VALUES 
        ('Wireless Noise-Canceling Headphones', 'High-fidelity audio with active noise cancellation.', 120.00, 25, 'https://images.unsplash.com/photo-1505740420928-5e560c06d30e?w=500'),
        ('Smart Fitness Watch', 'Waterproof fitness tracker with heart-rate and GPS monitoring.', 75.50, 40, 'https://images.unsplash.com/photo-1523275335684-37898b6baf30?w=500'),
        ('Mechanical Gaming Keyboard', 'RGB backlit mechanical keyboard with tactile switches.', 85.00, 15, 'https://images.unsplash.com/photo-1587829741301-dc798b83add3?w=500')
      ON CONFLICT DO NOTHING;
    `);

    // 3. Create Sample Order & Delivery
    const orderRes = await client.query(`
      INSERT INTO orders (customer_id, total_amount, payment_status)
      VALUES ($1, 195.50, 'paid')
      RETURNING id;
    `, [customer.id]);

    const orderId = orderRes.rows[0].id;
    const testTrackingCode = 'IQ-TEST88';

    await client.query(`
      INSERT INTO deliveries (
        order_id, 
        driver_id, 
        delivery_status, 
        recipient_name, 
        recipient_phone, 
        shipping_address, 
        tracking_code, 
        notes, 
        estimated_arrival
      )
      VALUES (
        $1, 
        $2, 
        'in_transit', 
        'Alice Customer', 
        '+256700000003', 
        'Plot 14 Kampala Road, Kampala, Uganda', 
        $3, 
        'Leave at reception if unavailable',
        NOW() + INTERVAL '2 hours'
      )
      ON CONFLICT (tracking_code) DO NOTHING;
    `, [orderId, driver.id, testTrackingCode]);

    await client.query('COMMIT');
    console.log('✅ Seeding complete!');
    console.log(`📦 Test Tracking Code created: ${testTrackingCode}`);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('❌ Seeding failed:', err);
  } finally {
    client.release();
    await pool.end();
  }
}

seed();
