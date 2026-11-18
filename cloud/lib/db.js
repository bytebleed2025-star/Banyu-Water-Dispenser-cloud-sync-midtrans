// One MongoDB connection, reused between requests while Vercel keeps the function warm.
let pending = null, override = null;
function getDb() {
  if (override) return Promise.resolve(override);
  if (!process.env.MONGODB_URI) return Promise.reject(new Error('MONGODB_URI is not set in Vercel (Project > Settings > Environment Variables)'));
  if (!pending) {
    const { MongoClient } = require('mongodb');
    pending = new MongoClient(process.env.MONGODB_URI, { maxPoolSize: 5, serverSelectionTimeoutMS: 8000 })
      .connect().then(c => c.db(process.env.MONGODB_DB || 'banyu'));
    pending.catch(() => { pending = null; });   // try again on the next request
  }
  return pending;
}
const setDbForTests = db => { override = db; };
module.exports = { getDb, setDbForTests };
