const express = require('express');
const cors = require('cors');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fetch = require('node-fetch');
require('dotenv').config();

const app = express();
const port = process.env.PORT || 3000;

// Rate limiting setup
const rateLimit = require('express-rate-limit');
const limiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 900000, // 15 minutes
  max: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS) || 50 // limit each IP to 50 requests per windowMs
});

// Middleware
app.use(cors({
  origin: ['https://philify.vercel.app', 'http://localhost:3000'],
  methods: ['GET', 'POST', 'DELETE'],
  credentials: true,
  allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json());
app.use(express.static('public'));
app.use('/api/', limiter); // Apply rate limiting to all API routes

// Database setup
const db = new sqlite3.Database('predictions.db', (err) => {
  if (err) {
    console.error('Error opening database:', err);
  } else {
    console.log('Connected to SQLite database');
    // Create predictions table if it doesn't exist
    db.run(`CREATE TABLE IF NOT EXISTS predictions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      price REAL NOT NULL,
      date TEXT NOT NULL,
      status TEXT NOT NULL,
      score REAL,
      current_price REAL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
  }
});

// Routes
app.get('/api/predictions', (req, res) => {
  db.all('SELECT * FROM predictions ORDER BY date DESC', [], (err, rows) => {
    if (err) {
      res.status(500).json({ error: err.message });
      return;
    }
    res.json(rows);
  });
});

app.post('/api/predictions', async (req, res) => {
  const { name, price, date } = req.body;
  
  if (!name || !price || !date) {
    res.status(400).json({ error: 'Missing required fields' });
    return;
  }

  try {
    // Get current Bitcoin price
    const currentPriceResponse = await fetch('https://api.coingecko.com/api/v3/coins/bitcoin/market_chart?vs_currency=usd&days=1', {
      headers: {
        'x-cg-pro-api-key': process.env.COINGECKO_API_KEY
      }
    });
    
    if (!currentPriceResponse.ok) {
      throw new Error('Failed to fetch current Bitcoin price');
    }
    
    const currentPriceData = await currentPriceResponse.json();
    const currentPrice = currentPriceData.prices[0][1];

    const today = new Date().toISOString().split('T')[0];
    const status = date <= today ? 'completed' : 'pending';
    const score = date <= today ? await calculateScore(price, date) : null;

    db.run(
      'INSERT INTO predictions (name, price, date, status, score, current_price) VALUES (?, ?, ?, ?, ?, ?)',
      [name, price, date, status, score, currentPrice],
      function(err) {
        if (err) {
          res.status(500).json({ error: err.message });
          return;
        }
        res.json({
          id: this.lastID,
          name,
          price,
          date,
          status,
          score,
          current_price: currentPrice
        });
      }
    );
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.delete('/api/predictions/:id', (req, res) => {
  db.run('DELETE FROM predictions WHERE id = ?', req.params.id, function(err) {
    if (err) {
      res.status(500).json({ error: err.message });
      return;
    }
    res.json({ message: 'Prediction deleted' });
  });
});

// Bitcoin price calculation helper with caching
const priceCache = new Map();
const CACHE_DURATION = 5 * 60 * 1000; // 5 minutes

async function calculateScore(price, date) {
  try {
    const [year, month, day] = date.split('-');
    const formattedDate = `${day}-${month}-${year}`;
    const today = new Date().toISOString().split('T')[0];
    
    // Check cache first
    const cacheKey = date === today ? 'current' : formattedDate;
    const cachedPrice = priceCache.get(cacheKey);
    const now = Date.now();
    
    let actualPrice;
    if (cachedPrice && (now - cachedPrice.timestamp) < CACHE_DURATION) {
      actualPrice = cachedPrice.price;
    } else {
      const apiUrl = date === today
        ? 'https://api.coingecko.com/api/v3/coins/bitcoin/market_chart?vs_currency=usd&days=1'
        : `https://api.coingecko.com/api/v3/coins/bitcoin/history?date=${formattedDate}`;

      const response = await fetch(apiUrl, {
        headers: {
          'x-cg-pro-api-key': process.env.COINGECKO_API_KEY
        }
      });
      
      if (!response.ok) {
        throw new Error('Failed to fetch Bitcoin price');
      }
      
      const data = await response.json();
      actualPrice = date === today ? data.prices[0][1] : data.market_data.current_price.usd;
      
      // Update cache
      priceCache.set(cacheKey, {
        price: actualPrice,
        timestamp: now
      });
    }

    const percentageError = Math.abs(price - actualPrice) / actualPrice * 100;
    const predictionDate = new Date(date);
    const todayDate = new Date(today);
    const daysDiff = Math.max(0, (todayDate - predictionDate) / (1000 * 60 * 60 * 24));
    const timeWeight = Math.log(daysDiff + 1);
    const maxTimeWeight = Math.log(365 + 1);

    let score = (100 - percentageError) * timeWeight / maxTimeWeight;
    return Math.max(0, Math.min(100, score));
  } catch (error) {
    console.error('Error calculating score:', error);
    return null;
  }
}

// Function to update scores for due predictions
async function updateDuePredictions() {
  const today = new Date().toISOString().split('T')[0];
  
  db.all('SELECT * FROM predictions WHERE date <= ? AND status = ?', [today, 'pending'], async (err, rows) => {
    if (err) {
      console.error('Error fetching due predictions:', err);
      return;
    }

    for (const row of rows) {
      try {
        const score = await calculateScore(row.price, row.date);
        db.run(
          'UPDATE predictions SET status = ?, score = ? WHERE id = ?',
          ['completed', score, row.id],
          (err) => {
            if (err) {
              console.error(`Error updating prediction ${row.id}:`, err);
            } else {
              console.log(`Updated prediction ${row.id} with score ${score}`);
            }
          }
        );
      } catch (error) {
        console.error(`Error calculating score for prediction ${row.id}:`, error);
      }
    }
  });
}

// Check for due predictions every hour
setInterval(updateDuePredictions, 60 * 60 * 1000);

// Start server
app.listen(port, '0.0.0.0', () => {
  console.log(`Server running at http://0.0.0.0:${port}`);
  // Run initial check for due predictions
  updateDuePredictions();
}); 