require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');

const deliveryRoutes = require('./modules/delivery/delivery.routes');

const app = express();

app.enable('trust proxy');
app.use(helmet());
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(morgan('dev'));

app.get('/healthz', (req, res) => {
  res.status(200).json({ status: 'ok', service: 'TheIQstore', time: new Date().toISOString() });
});

app.get('/', (req, res) => {
  res.json({ message: 'Welcome to TheIQstore API', docs: '/api/v1/deliveries' });
});

app.use('/api/v1/deliveries', deliveryRoutes);

app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: 'Internal Server Error', message: err.message });
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server listening on port ${PORT}`);
});
