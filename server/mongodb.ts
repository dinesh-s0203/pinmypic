import { MongoClient, GridFSBucket, Db } from 'mongodb';

export class MongoDBService {
  private client: MongoClient | null = null;
  private db: Db | null = null;
  private gridFS: GridFSBucket | null = null;
  private connectionString: string;

  constructor() {
    // Initialize connection string (will be set during connect())
    this.connectionString = '';
  }

  private initializeConnectionString() {
    // Use the provided MongoDB Atlas connection string from environment variables
    if (!process.env.MONGODB_URI) {
      throw new Error('MONGODB_URI environment variable is not set');
    }
    this.connectionString = process.env.MONGODB_URI;
    console.log('MongoDB URI initialized:', this.connectionString ? 'URI set' : 'URI missing');
  }

  async connect(): Promise<void> {
    try {
      if (!this.client) {
        // Initialize connection string with current environment variables
        this.initializeConnectionString();
        
        this.client = new MongoClient(this.connectionString, {
          serverSelectionTimeoutMS: 10000, // 10 second timeout for Atlas
          connectTimeoutMS: 10000,
        });
        await this.client.connect();
        
        // Test the connection
        await this.client.db('admin').command({ ping: 1 });
        
        // Use pinmypic database for the new MongoDB setup
        this.db = this.client.db('pinmypic');
        
        // Initialize GridFS bucket for file storage
        this.gridFS = new GridFSBucket(this.db, { bucketName: 'photos' });
      }
    } catch (error) {
      console.error('Failed to connect to MongoDB:', error);
      // Reset connection state
      this.client = null;
      this.db = null;
      this.gridFS = null;
      throw error;
    }
  }

  async disconnect(): Promise<void> {
    if (this.client) {
      await this.client.close();
      this.client = null;
      this.db = null;
      this.gridFS = null;
    }
  }

  getDb(): Db {
    if (!this.db) {
      throw new Error('MongoDB not connected');
    }
    return this.db;
  }

  getGridFS(): GridFSBucket {
    if (!this.gridFS) {
      throw new Error('GridFS not initialized');
    }
    return this.gridFS;
  }

  async ensureConnection(): Promise<void> {
    if (!this.client || !this.db || !this.gridFS) {
      await this.connect();
    }
  }
}

export const mongoService = new MongoDBService();