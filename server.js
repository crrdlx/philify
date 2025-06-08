// v0.0.4
const express = require('express');
const cors = require('cors');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fetch = require('node-fetch');
require('dotenv').config();

const app = express();
const port = process.env.PORT || 3000;

// Add request logging middleware
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} - ${req.method} ${req.url}`);
  // console.log('Headers:', req.headers); // Uncomment for more detailed header logging
  next();
});

// Rate limiting setup
const rateLimit = require('express-rate-limit');
const limiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 900000, // 15 minutes
  max: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS) || 50 // limit each IP to 50 requests per windowMs
});

// Middleware
app.use(cors({
  origin: '*', // Allow all origins during development
  methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
  credentials: true,
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Accept'],
  exposedHeaders: ['Content-Type', 'Authorization'],
  maxAge: 86400 // Cache preflight requests for 24 hours
}));

// Add error logging middleware
app.use((err, req, res, next) => {
  console.error('Error:', err);
  if (err.name === 'CORSError') {
    res.status(403).json({ error: 'CORS error: ' + err.message });
  } else {
    res.status(500).json({ error: err.message });
  }
});

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
      source TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
  }
});

// Add a debug endpoint to view database contents
app.get('/api/debug/db', (req, res) => {
  console.log('Fetching all database contents...');
  db.all('SELECT * FROM predictions ORDER BY created_at DESC', [], (err, rows) => {
    if (err) {
      console.error('Database error:', err);
      res.status(500).json({ error: err.message });
      return;
    }
    // Format the response to be more readable
    const formattedRows = rows.map(row => ({
      id: row.id,
      name: row.name,
      price: row.price,
      date: row.date,
      status: row.status,
      score: row.score,
      current_price: row.current_price,
      source: row.source,
      created_at: row.created_at
    }));
    res.json(formattedRows);
  });
});

// Routes
app.get('/api/predictions', (req, res) => {
  console.log('Fetching predictions from database...');
  db.all('SELECT * FROM predictions ORDER BY date DESC', [], (err, rows) => {
    if (err) {
      console.error('Database error:', err);
      res.status(500).json({ error: err.message });
      return;
    }
    console.log('Found predictions:', rows);
    res.json(rows);
  });
});

app.post('/api/predictions', async (req, res) => {
  const { name, price, date, source } = req.body;
  
  if (!name || !price || !date) {
    res.status(400).json({ error: 'Missing required fields' });
    return;
  }

  try {
    // Get current Bitcoin price at the time of prediction
    const currentPriceResponse = await fetch('https://api.coingecko.com/api/v3/coins/bitcoin/market_chart?vs_currency=usd&days=1', {
      headers: {
        'x-cg-pro-api-key': process.env.COINGECKO_API_KEY
      }
    });
    
    if (!currentPriceResponse.ok) {
      console.error('Failed to fetch current Bitcoin price for new prediction:', await currentPriceResponse.text());
      throw new Error('Failed to fetch current Bitcoin price');
    }
    
    const currentPriceData = await currentPriceResponse.json();
    // Ensure data format is correct for current price
    if (!currentPriceData.prices || !currentPriceData.prices[0]) {
         console.error('Unexpected data format for current price API on new prediction:', currentPriceData);
         throw new Error('Unexpected data format from CoinGecko (current price)');
    }
    const priceAtPrediction = currentPriceData.prices[0][1];

    const today = new Date().toISOString().split('T')[0];
    const status = date <= today ? 'completed' : 'pending';
    // Calculate score only if the date is today or in the past
    const score = date <= today ? await calculateScore(price, date) : null;

    db.run(
      'INSERT INTO predictions (name, price, date, status, score, current_price, source) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [name, price, date, status, score, priceAtPrediction, source || null],
      function(err) {
        if (err) {
          console.error('Database error saving prediction:', err);
          res.status(500).json({ error: err.message });
          return;
        }
        console.log('Prediction saved with ID:', this.lastID);
        res.json({
          id: this.lastID,
          name,
          price,
          date,
          status,
          score,
          current_price: priceAtPrediction,
          source: source || null
        });
      }
    );
  } catch (error) {
    console.error('Error adding prediction:', error);
    res.status(500).json({ error: error.message });
  }
});

app.delete('/api/predictions/:id', (req, res) => {
  console.log('Deleting prediction with ID:', req.params.id);
  db.run('DELETE FROM predictions WHERE id = ?', req.params.id, function(err) {
    if (err) {
      console.error('Database error deleting prediction:', err);
      res.status(500).json({ error: err.message });
      return;
    }
    console.log('Prediction deleted with ID:', req.params.id);
    res.json({ message: 'Prediction deleted' });
  });
});

// Bitcoin price calculation helper with caching
const priceCache = new Map();
const CACHE_DURATION = 5 * 60 * 1000; // 5 minutes

async function calculateScore(predictedPrice, predictionDate) {
  try {
    const [year, month, day] = predictionDate.split('-');
    const formattedDate = `${day}-${month}-${year}`;
    const today = new Date().toISOString().split('T')[0];
    const todayDateObj = new Date(today);
    const predictionDateObj = new Date(predictionDate);
    const daysDiff = Math.max(0, (todayDateObj - predictionDateObj) / (1000 * 60 * 60 * 24));

    console.log(`Calculating score for prediction on ${predictionDate} (days difference: ${daysDiff})`);

    // Check cache first
    const cacheKey = predictionDate === today ? 'current' : formattedDate;
    const cachedPrice = priceCache.get(cacheKey);
    const now = Date.now();
    
    let actualPrice;
    if (cachedPrice && (now - cachedPrice.timestamp) < CACHE_DURATION) {
      console.log(`Using cached price for ${cacheKey}`);
      actualPrice = cachedPrice.price;
    } else {
      const apiUrl = predictionDate === today
        ? 'https://api.coingecko.com/api/v3/coins/bitcoin/market_chart?vs_currency=usd&days=1'
        : `https://api.coingecko.com/api/v3/coins/bitcoin/history?date=${formattedDate}`;

      console.log(`Fetching price from CoinGecko API for score calculation: ${apiUrl}`);
      const response = await fetch(apiUrl, {
        headers: {
          'x-cg-pro-api-key': process.env.COINGECKO_API_KEY || ''
        }
      });
      
      if (!response.ok) {
        const errorText = await response.text();
        console.error(`CoinGecko API for score calculation returned non-ok status: ${response.status} - ${response.statusText}. Body: ${errorText}`);
        throw new Error('Failed to fetch Bitcoin price from CoinGecko for score calculation');
      }
      
      const data = await response.json();
      
      if (predictionDate === today) {
           if (!data.prices || !data.prices[0]) {
               console.error('Unexpected data format for current price API (score calc):', data);
               throw new Error('Unexpected data format from CoinGecko (current price for score calc)');
           }
           actualPrice = data.prices[0][1];
      } else {
           if (!data.market_data || !data.market_data.current_price || !data.market_data.current_price.usd) {
               console.error('Unexpected data format for historical price API (score calc):', data);
               throw new Error('Unexpected data format from CoinGecko (historical price for score calc)');
           }
           actualPrice = data.market_data.current_price.usd;
      }

      console.log(`Successfully fetched actual price for ${formattedDate} (score calc): ${actualPrice}`);
      
      // Update cache
      priceCache.set(cacheKey, {
        price: actualPrice,
        timestamp: now
      });
    }

    // Calculate percentage error
    const percentageError = Math.abs(predictedPrice - actualPrice) / actualPrice * 100;
    console.log(`Predicted: ${predictedPrice}, Actual: ${actualPrice}, Percentage Error: ${percentageError.toFixed(2)}%`);

    // Base time weight with exponential growth
    const timeWeight = Math.pow(daysDiff + 1, 0.5) / Math.pow(365 + 1, 0.5);
    console.log(`Base Time Weight: ${timeWeight.toFixed(4)} (Days Difference: ${daysDiff})`);
    
    // Short-term bonus (up to 0.7x for very short predictions)
    const shortTermBonus = daysDiff <= 7 ? (7 - daysDiff) * 0.1 : 0;
    console.log(`Short-term Bonus: ${shortTermBonus.toFixed(4)}`);
    
    // Accuracy bonus for short-term predictions
    const accuracyBonus = daysDiff <= 7 && percentageError < 5 ? 20 : 0;
    console.log(`Accuracy Bonus: ${accuracyBonus}`);
    
    // Calculate final score
    let score = Math.max(0, 100 - percentageError) * (1 + timeWeight + shortTermBonus) + accuracyBonus;
    score = Math.max(0, Math.min(100, score)); // Cap between 0 and 100

    console.log(`Calculated Score: ${score.toFixed(2)}`);

    return score;
  } catch (error) {
    console.error('Error calculating score:', error);
    return null;
  }
}

// Function to update scores for due predictions
async function updateDuePredictions() {
  const today = new Date().toISOString().split('T')[0];
  
  console.log(`Checking for due predictions on ${today}...`);

  db.all('SELECT * FROM predictions WHERE date <= ? AND status = ?', [today, 'pending'], async (err, rows) => {
    if (err) {
      console.error('Database error fetching due predictions:', err);
      return;
    }

    console.log(`Found ${rows.length} due predictions to update`);

    for (const row of rows) {
      try {
        console.log(`Processing due prediction ID: ${row.id}, Date: ${row.date}, Status: ${row.status}`);
        const score = await calculateScore(row.price, row.date);
        
        if (score !== null) {
             db.run(
               'UPDATE predictions SET status = ?, score = ? WHERE id = ?',
               ['completed', score, row.id],
               (err) => {
                 if (err) {
                   console.error(`Database error updating prediction ${row.id}:`, err);
                 } else {
                   console.log(`Updated prediction ${row.id} with score ${score.toFixed(2)}`);
                 }
               }
             );
        } else {
             console.log(`Score calculation returned null for prediction ${row.id}. Skipping update.`);
        }

      } catch (error) {
        console.error(`Error processing due prediction ${row.id}:`, error);
      }
    }
  });
}

// Check for due predictions every hour (60 * 60 * 1000 ms)
setInterval(updateDuePredictions, 60 * 60 * 1000);
console.log('Scheduled hourly prediction score updates.');

// Start server
app.listen(port, '0.0.0.0', () => {
  console.log(`Server running at http://0.0.0.0:${port}`);
  // Run initial check for due predictions on startup
  updateDuePredictions();
});
console.log('Server starting...'); 