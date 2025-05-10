const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const app = express();
const port = process.env.PORT || 5000;

// Middleware
app.use(cors({
  origin: 'https://philify.vercel.app', // Allow requests from the deployed frontend
}));
app.use(express.json());

// MongoDB Connection
mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost/philify', {
  useNewUrlParser: true,
  useUnifiedTopology: true,
}).then(() => console.log('Connected to MongoDB'))
  .catch((err) => console.error('MongoDB connection error:', err));

// Prediction Schema
const predictionSchema = new mongoose.Schema({
  name: String,
  predictedPrice: Number,
  targetDate: String,
  daysAhead: Number,
  status: String,
  actualPrice: Number,
  score: Number,
});

const Prediction = mongoose.model('Prediction', predictionSchema);

// Mock BTC Price Function (replace with real API in production)
const getBTCPrice = (date) => {
  const baseDate = new Date('2025-05-10');
  const daysDiff = (new Date(date) - baseDate) / (1000 * 60 * 60 * 24);
  return 100000 + daysDiff * 100; // Linear increase for demo
};

// Calculate Philify Score
const calculatePhilifyScore = (predictedPrice, actualPrice, daysAhead) => {
  const accuracyError = Math.abs(actualPrice - predictedPrice) / actualPrice * 100;
  const baseScore = 100 - accuracyError;
  const timeFactor = Math.log(daysAhead + 1) * 2; // k=2 for balance
  const finalScore = baseScore * timeFactor;
  return Math.min(100, Math.max(-100, Math.round(finalScore))); // Cap at -100 to 100
};

// API Endpoints
// Submit a prediction
app.post('/api/predictions', async (req, res) => {
  try {
    const { name, predictedPrice, targetDate } = req.body;
    const today = new Date();
    const target = new Date(targetDate);
    const daysAhead = Math.round((target - today) / (1000 * 60 * 60 * 24));
    
    if (daysAhead < 0) {
      return res.status(400).json({ error: 'Target date must be in the future' });
    }

    const prediction = new Prediction({
      name,
      predictedPrice,
      targetDate,
      daysAhead,
      status: 'pending',
      actualPrice: null,
      score: null,
    });

    await prediction.save();
    res.status(201).json(prediction);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Get all predictions
app.get('/api/predictions', async (req, res) => {
  try {
    const predictions = await Prediction.find();
    res.json(predictions);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Check predictions and calculate scores
app.post('/api/check', async (req, res) => {
  try {
    const predictions = await Prediction.find({ status: 'pending' });
    const updatedPredictions = [];

    for (const pred of predictions) {
      if (new Date(pred.targetDate) <= new Date()) {
        const actualPrice = getBTCPrice(pred.targetDate);
        const score = calculatePhilifyScore(pred.predictedPrice, actualPrice, pred.daysAhead);
        pred.status = 'completed';
        pred.actualPrice = actualPrice;
        pred.score = score;
        await pred.save();
        updatedPredictions.push(pred);
      }
    }

    res.json(updatedPredictions);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Get rankings
app.get('/api/rankings', async (req, res) => {
  try {
    const predictions = await Prediction.find({ status: 'completed' });
    const scores = {};

    predictions.forEach((pred) => {
      if (!scores[pred.name]) {
        scores[pred.name] = { totalScore: 0, count: 0 };
      }
      scores[pred.name].totalScore += pred.score;
      scores[pred.name].count += 1;
    });

    const rankings = Object.entries(scores)
      .map(([name, { totalScore, count }]) => ({
        name,
        averageScore: Math.round(totalScore / count),
      }))
      .sort((a, b) => b.averageScore - a.averageScore);

    res.json(rankings);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Start server
app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});