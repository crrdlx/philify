const sqlite3 = require('sqlite3').verbose();
const fetch = require('node-fetch');
require('dotenv').config();

const db = new sqlite3.Database('predictions.db', (err) => {
  if (err) {
    console.error('Error opening database:', err);
    process.exit(1);
  }
  console.log('Connected to database');
});

// Add current_price column if it doesn't exist
db.run(`ALTER TABLE predictions ADD COLUMN current_price REAL`, (err) => {
  if (err && !err.message.includes('duplicate column name')) {
    console.error('Error adding column:', err);
    process.exit(1);
  }
  console.log('Column added or already exists');
});

// Update existing records with current price
db.all('SELECT id, date FROM predictions WHERE current_price IS NULL', [], async (err, rows) => {
  if (err) {
    console.error('Error fetching records:', err);
    process.exit(1);
  }

  console.log(`Found ${rows.length} records to update`);

  for (const row of rows) {
    try {
      const [year, month, day] = row.date.split('-');
      const formattedDate = `${day}-${month}-${year}`;
      
      const response = await fetch(`https://api.coingecko.com/api/v3/coins/bitcoin/history?date=${formattedDate}`, {
        headers: {
          'x-cg-pro-api-key': process.env.COINGECKO_API_KEY
        }
      });
      
      if (!response.ok) {
        throw new Error('Failed to fetch price');
      }
      
      const data = await response.json();
      const price = data.market_data.current_price.usd;

      db.run('UPDATE predictions SET current_price = ? WHERE id = ?', [price, row.id], (err) => {
        if (err) {
          console.error(`Error updating record ${row.id}:`, err);
        } else {
          console.log(`Updated record ${row.id}`);
        }
      });
    } catch (error) {
      console.error(`Error processing record ${row.id}:`, error);
    }
  }
});

// Close database connection after all updates
setTimeout(() => {
  db.close((err) => {
    if (err) {
      console.error('Error closing database:', err);
    } else {
      console.log('Database connection closed');
    }
    process.exit(0);
  });
}, 10000); // Wait 10 seconds to allow updates to complete 