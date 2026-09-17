const mongoose = require("mongoose");

/**
 * Connects to MongoDB.
 *
 * Why we exit on failure instead of only logging:
 * if the database is unreachable, every request would hang or crash
 * anyway. Stopping immediately gives you a clear error in the terminal
 * instead of a server that claims to be "running" but cannot work.
 */
const connectDB = async () => {
  try {
    await mongoose.connect(process.env.MONGO_URI);
    console.log("MongoDB connected");
  } catch (error) {
    // We print only the message, never the connection string,
    // because the connection string contains your username and password.
    console.error("MongoDB connection failed:", error.message);
    process.exit(1);
  }
};

module.exports = connectDB;
