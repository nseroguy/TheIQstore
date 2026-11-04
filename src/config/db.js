const { Pool } = require('pg');
require('dotenv').config();

const connectionString = process.env.DATABASE_URL;

const pool = new Pool({
  connectionString,
  ssl: process.env.NODE_ENV === 'production' || (connectionString && connectionString.includes('render.com'))
    ? { rejectUnauthorized: false }
    : false
});

pool.on('error', (err) => {
  console.error('Unexpected database error on idle client:', err);
});

module.exports = {
  query: (text, params) => pool.query(text, params),
  pool
};
