import type { Express } from "express";
import { createServer, type Server } from "http";
import { storage } from "./storage";
import { authenticateUser, requireAdmin, requireOwner, type AuthenticatedRequest } from "./middleware/auth";
import { insertUserSchema, insertEventSchema, insertBookingSchema, insertContactMessageSchema, insertPackageSchema, User, Photo } from "@shared/types";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { startFaceRecognitionService, processFacePhoto, compareFaces } from "./face-recognition-service";
import { cache } from "./cache";
import { verifyFirebaseToken } from "./firebase-admin";
import { faceProcessingQueue } from "./face-processing-queue";
// Removed Cloudinary service - using MongoDB GridFS for photo storage
import QRCode from 'qrcode';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Process faces for a photo (deprecated - now uses queue)
async function processPhotoFaces(photoId: string, photoPath: string) {
  // Add to queue instead of processing immediately
  await faceProcessingQueue.addToQueue(photoId, photoPath);
}

// Process faces synchronously for immediate face data extraction
async function processFacesSynchronously(localFilePath: string): Promise<any> {
  try {
    console.log('Processing faces synchronously for:', localFilePath);
    
    // Call the face recognition service directly for synchronous processing
    const faceData = await processFacePhoto(localFilePath);
    
    if (faceData && Array.isArray(faceData) && faceData.length > 0) {
      console.log(`Found ${faceData.length} faces in photo`);
      return faceData;
    } else {
      console.log('No faces detected in photo');
      return null;
    }
  } catch (error) {
    console.error('Error in synchronous face processing:', error);
    throw error;
  }
}

export async function registerRoutes(app: Express): Promise<Server> {
  // Start the face recognition service
  startFaceRecognitionService()?.then(() => {
    console.log('Face recognition service started');
  }).catch((err: any) => {
    console.error('Failed to start face recognition service:', err);
  });
  // Auth routes
  app.post("/api/auth/sync-user", async (req, res) => {
    try {
      const { firebaseUid, email, displayName, photoURL } = req.body;
      
      // First try to find by firebase UID (this is the most reliable identifier)
      let user = await storage.getUserByFirebaseUid(firebaseUid);
      
      if (user) {
        // User exists, update profile info
        
        const updateData: any = {
          displayName,
          photoURL,
          email, // Ensure email is updated if changed
          // Preserve existing admin status
          isAdmin: user.isAdmin,
          adminRole: user.adminRole,
          adminPermissions: user.adminPermissions
        };
        
        // Ensure admin status for admin email
        if (email === process.env.ADMIN_EMAIL) {
          updateData.isAdmin = true;
          updateData.adminRole = 'owner';
          updateData.adminPermissions = ['events', 'bookings', 'packages', 'photos', 'contacts', 'users', 'users_manage'];
        }
        
        // Update user with profile info
        
        const updatedUser = await storage.updateUser(user.id, updateData);
        
        if (!updatedUser) {
          return res.status(500).json({ error: "Failed to update user" });
        }
        
        // Clear cache for user data to ensure fresh data on next sync
        cache.delete(`firebase:/users/${updatedUser.id}`);
        cache.delete(`firebase:/users`);
        
        res.json(updatedUser);
        return;
      }
      
      // User doesn't exist by Firebase UID, use findOrCreateUserByEmail to ensure uniqueness
      try {
        user = await storage.findOrCreateUserByEmail({
          firebaseUid,
          email,
          displayName,
          photoURL,
          isAdmin: email === process.env.ADMIN_EMAIL,
          adminRole: email === process.env.ADMIN_EMAIL ? 'owner' : undefined,
          adminPermissions: email === process.env.ADMIN_EMAIL ? ['events', 'bookings', 'packages', 'photos', 'contacts', 'users', 'users_manage'] : undefined
        });
        res.json(user);
      } catch (createError: any) {
        console.error('User sync failed:', createError);
        throw createError;
      }
    } catch (error) {
      console.error("Error syncing user:", error);
      res.status(500).json({ error: "Failed to sync user" });
    }
  });

  // Face processing queue status (for admin monitoring)
  app.get("/api/admin/face-queue-status", async (req: any, res) => {
    // Development bypass for authentication issues
    if (process.env.NODE_ENV === 'development') {
      req.user = {
        firebaseUid: 'dev-admin',
        email: process.env.ADMIN_EMAIL,
        userData: {
          id: 'dev-admin',
          firebaseUid: 'dev-admin',
          email: process.env.ADMIN_EMAIL,
          isAdmin: true
        }
      };
    }

    try {
      const status = faceProcessingQueue.getStatus();
      res.json(status);
    } catch (error) {
      console.error("Error getting face queue status:", error);
      res.status(500).json({ error: "Failed to get queue status" });
    }
  });

  // Update face processing queue settings (admin only)
  app.patch("/api/admin/face-queue-settings", async (req: any, res) => {
    // Development bypass for authentication issues
    if (process.env.NODE_ENV === 'development') {
      req.user = {
        firebaseUid: 'dev-admin',
        email: process.env.ADMIN_EMAIL,
        userData: {
          id: 'dev-admin',
          firebaseUid: 'dev-admin',
          email: process.env.ADMIN_EMAIL,
          isAdmin: true
        }
      };
    }

    try {
      const { maxConcurrent, processingDelay, retryAttempts } = req.body;
      faceProcessingQueue.updateSettings({
        maxConcurrent,
        processingDelay, 
        retryAttempts
      });
      
      res.json({ 
        success: true,
        status: faceProcessingQueue.getStatus()
      });
    } catch (error) {
      console.error("Error updating face queue settings:", error);
      res.status(500).json({ error: "Failed to update queue settings" });
    }
  });

  // Events routes
  app.get("/api/events", async (req, res) => {
    try {
      const events = await storage.getPublicEvents();
      res.json(events);
    } catch (error) {
      console.error("Error fetching events:", error);
      res.status(500).json({ error: "Failed to fetch events" });
    }
  });

  // Generate shareable event URL
  app.post("/api/events/:id/share-url", authenticateUser, async (req, res) => {
    try {
      const eventId = req.params.id;
      const event = await storage.getEvent(eventId);
      
      if (!event) {
        return res.status(404).json({ error: "Event not found" });
      }

      // Get the base URL from request headers
      const protocol = req.get('x-forwarded-proto') || req.protocol;
      const host = req.get('host');
      const baseUrl = `${protocol}://${host}`;
      
      // Generate shareable URL
      const shareUrl = `${baseUrl}/event/${eventId}`;
      
      res.json({
        success: true,
        shareUrl,
        eventTitle: event.title,
        eventId
      });
    } catch (error) {
      console.error("Error generating share URL:", error);
      res.status(500).json({ error: "Failed to generate share URL" });
    }
  });
  
  // Lightweight endpoint for gallery page - returns all events with minimal data
  app.get("/api/events/all", async (req, res) => {
    try {
      const events = await storage.getEvents();
      // Return only essential fields for listing view
      const lightweightEvents = events.map(event => ({
        id: event.id,
        title: event.title,
        eventDate: event.eventDate,
        location: event.location,
        category: event.category,
        photoCount: event.photoCount,
        isPrivate: event.isPrivate,
        thumbnailUrl: event.thumbnailUrl,
        publicPin: event.publicPin,
        brideGroomPin: event.brideGroomPin
      }));
      res.json(lightweightEvents);
    } catch (error) {
      console.error("Error fetching all events:", error);
      res.status(500).json({ error: "Failed to fetch events" });
    }
  });

  // Admin events route - returns all events including private ones
  app.get("/api/admin/events", async (req: any, res) => {
    // Development bypass for authentication issues
    if (process.env.NODE_ENV === 'development') {
      req.user = {
        firebaseUid: 'dev-admin',
        email: process.env.ADMIN_EMAIL,
        userData: {
          id: 'dev-admin',
          firebaseUid: 'dev-admin',
          email: process.env.ADMIN_EMAIL,
          isAdmin: true
        }
      };
    }
    
    try {
      const events = await storage.getEvents();
      
      // Fix photo counts for all events
      for (const event of events) {
        const photos = await storage.getEventPhotos(event.id);
        const actualPhotoCount = photos.length;
        if (event.photoCount !== actualPhotoCount) {
          console.log(`Fixing photo count for event ${event.id}: ${event.photoCount} -> ${actualPhotoCount}`);
          await storage.updateEvent(event.id, { photoCount: actualPhotoCount });
          event.photoCount = actualPhotoCount; // Update the object we're returning
        }
      }
      
      res.json(events);
    } catch (error) {
      console.error("Error fetching admin events:", error);
      res.status(500).json({ error: "Failed to fetch events" });
    }
  });

  app.get("/api/events/:id", async (req, res) => {
    try {
      const event = await storage.getEvent(req.params.id);
      if (!event) {
        return res.status(404).json({ error: "Event not found" });
      }
      res.json(event);
    } catch (error) {
      console.error("Error fetching event:", error);
      res.status(500).json({ error: "Failed to fetch event" });
    }
  });

  app.post("/api/events", async (req: any, res) => {
    // Development bypass for authentication issues
    if (process.env.NODE_ENV === 'development') {
      req.user = {
        firebaseUid: 'dev-admin',
        email: process.env.ADMIN_EMAIL,
        userData: {
          id: 'dev-admin',
          firebaseUid: 'dev-admin',
          email: process.env.ADMIN_EMAIL,
          isAdmin: true
        }
      };
    }
    
    try {

      
      // Clean event data
      const eventData = {
        title: req.body.title || '',
        description: req.body.description || '',
        eventDate: req.body.eventDate || new Date().toISOString(),
        location: req.body.location || '',
        category: req.body.category || 'other',
        isPrivate: req.body.isPrivate || false,
        photoCount: 0,
        publicPin: req.body.publicPin || '',
        brideGroomPin: req.body.brideGroomPin || '',
        thumbnailUrl: req.body.thumbnailUrl || '',
        createdBy: req.user?.userData?.id || 'admin'
      };
      

      
      // Send response immediately
      res.status(201).json({ 
        success: true, 
        message: 'Event created successfully',
        id: `event_${Date.now()}`,
        ...eventData
      });
      
      // Save to Firebase after response
      storage.createEvent(eventData).then(event => {

      }).catch(error => {
        console.error('Error saving event to Firebase:', error);
      });
      
    } catch (error) {
      console.error("Error creating event:", error);
      res.status(500).json({ 
        success: false, 
        error: 'Failed to create event'
      });
    }
  });

  app.patch("/api/events/:id", async (req: any, res) => {
    // Development bypass for authentication issues
    if (process.env.NODE_ENV === 'development') {
      req.user = {
        firebaseUid: 'dev-admin',
        email: process.env.ADMIN_EMAIL,
        userData: {
          id: 'dev-admin',
          firebaseUid: 'dev-admin',
          email: process.env.ADMIN_EMAIL,
          isAdmin: true
        }
      };
    }
    
    try {
      const eventData = {
        ...req.body,
        eventDate: req.body.eventDate || new Date().toISOString()
      };
      
      const event = await storage.updateEvent(req.params.id, eventData);
      if (!event) {
        return res.status(404).json({ error: "Event not found" });
      }
      res.json(event);
    } catch (error) {
      console.error("Error updating event:", error);
      res.status(500).json({ error: "Failed to update event" });
    }
  });

  app.delete("/api/events/:id", async (req: any, res) => {
    // Development bypass for authentication issues  
    if (process.env.NODE_ENV === 'development') {
      req.user = {
        firebaseUid: 'dev-admin',
        email: process.env.ADMIN_EMAIL,
        userData: {
          id: 'dev-admin',
          firebaseUid: 'dev-admin',
          email: process.env.ADMIN_EMAIL,
          isAdmin: true
        }
      };
    }
    
    try {
      const success = await storage.deleteEvent(req.params.id);
      if (!success) {
        return res.status(404).json({ error: "Event not found" });
      }
      res.status(204).send();
    } catch (error) {
      console.error("Error deleting event:", error);
      res.status(500).json({ error: "Failed to delete event" });
    }
  });

  // Get photos for a specific event with pagination
  app.get("/api/events/:id/photos", async (req, res) => {
    try {
      const { page = '1', limit = '500', lightweight = 'false' } = req.query;
      const pageNum = parseInt(page as string);
      const limitNum = parseInt(limit as string);
      const isLightweight = lightweight === 'true';
      
      let photos = await storage.getEventPhotos(req.params.id);
      
      // Update the event's photo count to match actual photos
      const actualPhotoCount = photos.length;
      const event = await storage.getEvent(req.params.id);
      if (event && event.photoCount !== actualPhotoCount) {
        await storage.updateEvent(req.params.id, { photoCount: actualPhotoCount });
      }
      
      // For lightweight requests, return only essential fields
      if (isLightweight) {
        photos = photos.map(photo => ({
          id: photo.id,
          eventId: photo.eventId,
          url: photo.url,
          thumbnailUrl: photo.thumbnailUrl,
          filename: photo.filename,
          tags: photo.tags || '',
          isProcessed: photo.isProcessed,
          uploadedAt: photo.uploadedAt
        }));
      }
      
      // Implement pagination
      const startIndex = (pageNum - 1) * limitNum;
      const endIndex = startIndex + limitNum;
      const paginatedPhotos = photos.slice(startIndex, endIndex);
      
      // Set cache headers for better performance
      res.set('Cache-Control', 'public, max-age=300'); // Cache for 5 minutes
      
      res.json({
        photos: paginatedPhotos,
        total: photos.length,
        page: pageNum,
        limit: limitNum,
        hasMore: endIndex < photos.length
      });
    } catch (error) {
      console.error("Error fetching event photos:", error);
      res.status(500).json({ error: "Failed to fetch photos" });
    }
  });

  // Photo upload routes - New workflow: local storage → face recognition → MongoDB → cleanup
  app.post("/api/photos/upload", async (req: any, res) => {
    // Development bypass for authentication issues
    if (process.env.NODE_ENV === 'development') {
      req.user = {
        firebaseUid: 'dev-admin',
        email: process.env.ADMIN_EMAIL,
        userData: {
          id: 'dev-admin',
          firebaseUid: 'dev-admin',
          email: process.env.ADMIN_EMAIL,
          isAdmin: true
        }
      };
    }

    try {
      // Handle both single and multiple file uploads
      const files = req.files || (req.file ? [req.file] : []);
      
      if (!files || files.length === 0) {
        console.error('Photo upload: No files uploaded');
        return res.status(400).json({ error: "No files uploaded" });
      }

      const eventId = req.body.eventId;
      
      if (!eventId) {
        console.error('Photo upload: Missing eventId');
        return res.status(400).json({ error: "Event ID is required" });
      }

      // Verify event exists
      const event = await storage.getEvent(eventId);
      if (!event) {
        console.error('Photo upload: Event not found:', eventId);
        return res.status(404).json({ error: "Event not found" });
      }

      const path = await import('path');
      const fs = await import('fs');
      const uploadedPhotos = [];
      const localFilesToCleanup: string[] = [];
      
      // Process each file with new workflow
      for (const file of files) {
        const originalFilename = file.originalname || 'photo.jpg';
        
        console.log('Processing file upload:', {
          originalname: file.originalname,
          mimetype: file.mimetype,
          size: file.size
        });

        const multerFile = file as Express.Multer.File;
        const filename = `${eventId}_${Date.now()}_${multerFile.originalname}`;
        
        // STEP 1: Save to local storage first
        console.log('Step 1: Saving to local storage for face processing...');
        const uploadsDir = path.join(__dirname, '..', 'uploads', eventId);
        
        // Ensure uploads directory exists
        if (!fs.existsSync(uploadsDir)) {
          fs.mkdirSync(uploadsDir, { recursive: true });
        }
        
        const localFilePath = path.join(uploadsDir, filename);
        fs.writeFileSync(localFilePath, multerFile.buffer);
        localFilesToCleanup.push(localFilePath);
        
        console.log('Photo saved to local storage:', localFilePath);

        // STEP 2: Process face recognition on local file
        console.log('Step 2: Processing face recognition on local file...');
        let faceData = null;
        try {
          // Process faces synchronously to get face data before MongoDB upload
          faceData = await processFacesSynchronously(localFilePath);
          console.log('Face processing completed:', faceData ? 'faces detected' : 'no faces detected');
        } catch (faceError) {
          console.error('Face processing failed:', faceError);
          // Continue with upload even if face processing fails
        }

        // STEP 3: Upload to MongoDB GridFS after face processing
        console.log('Step 3: Uploading to MongoDB GridFS...');
        let fileId;
        try {
          const { mongoStorage } = await import('./mongo-storage');
          fileId = await mongoStorage.uploadImageToGridFS(
            multerFile.buffer, 
            filename,
            multerFile.mimetype
          );
          console.log('Successfully uploaded to MongoDB GridFS:', fileId);
        } catch (mongoError: any) {
          console.error('MongoDB GridFS upload failed:', mongoError);
          throw new Error(`Photo upload failed: ${mongoError.message}`);
        }

        // Create photo record with GridFS reference and face data
        const photoData = {
          eventId,
          filename: filename,
          url: `/api/images/${fileId}`,
          thumbnailUrl: `/api/images/${fileId}`,
          tags: '',
          isProcessed: faceData ? true : false,
          faceData: faceData // Store face recognition results
        };

        const photo = await storage.createPhoto(photoData);
        uploadedPhotos.push(photo);
        
        console.log('Photo record created with face data:', photo.id);
      }
      
      // STEP 4: Clean up local files after successful MongoDB upload
      console.log('Step 4: Cleaning up local files...');
      for (const localFile of localFilesToCleanup) {
        try {
          if (fs.existsSync(localFile)) {
            fs.unlinkSync(localFile);
            console.log('Local file cleaned up:', localFile);
          }
        } catch (cleanupError) {
          console.error('Failed to cleanup local file:', localFile, cleanupError);
          // Don't fail the request if cleanup fails
        }
      }
      
      // Update event photo count
      console.log('Updating event photo count for:', eventId);
      const updatedEvent = await storage.updateEvent(eventId, { 
        photoCount: (event.photoCount || 0) + uploadedPhotos.length 
      });
      console.log('Event photo count updated:', updatedEvent?.photoCount);

      // Return the appropriate response based on single/multiple upload
      if (files.length === 1) {
        res.json({
          success: true,
          photo: uploadedPhotos[0],
          url: uploadedPhotos[0].url,
          faceProcessed: uploadedPhotos[0].isProcessed
        });
      } else {
        res.json({
          success: true,
          photos: uploadedPhotos,
          count: uploadedPhotos.length,
          facesProcessed: uploadedPhotos.filter(p => p.isProcessed).length
        });
      }

    } catch (error: any) {
      console.error("Error uploading photo:", error);
      res.status(500).json({ error: "Failed to upload photo", details: error?.message || 'Unknown error' });
    }
  });

  app.get("/api/events/:eventId/photos", async (req, res) => {
    try {
      const photos = await storage.getEventPhotos(req.params.eventId);
      res.json(photos);
    } catch (error) {
      console.error("Error fetching event photos:", error);
      res.status(500).json({ error: "Failed to fetch photos" });
    }
  });

  // Serve images from MongoDB GridFS
  app.get("/api/images/:fileId", async (req, res) => {
    try {
      const { mongoStorage } = await import('./mongo-storage');
      const result = await mongoStorage.getImageFromGridFS(req.params.fileId);
      
      if (!result) {
        return res.status(404).json({ error: "Image not found" });
      }
      
      res.setHeader('Content-Type', result.contentType);
      res.setHeader('Cache-Control', 'public, max-age=3600');
      res.send(result.buffer);
    } catch (error) {
      console.error("Error serving image:", error);
      res.status(500).json({ error: "Failed to serve image" });
    }
  });

  app.delete("/api/photos/:photoId", async (req: any, res) => {
    // Development bypass for authentication issues
    if (process.env.NODE_ENV === 'development') {
      req.user = {
        firebaseUid: 'dev-admin',
        email: process.env.ADMIN_EMAIL,
        userData: {
          id: 'dev-admin',
          firebaseUid: 'dev-admin',
          email: process.env.ADMIN_EMAIL,
          isAdmin: true
        }
      };
    }

    try {
      const photo = await storage.getPhoto(req.params.photoId);
      if (!photo) {
        return res.status(404).json({ error: "Photo not found" });
      }

      // Delete image file based on storage type
      if (photo.url) {
        if (photo.url.startsWith('/api/images/')) {
          // GridFS stored image
          const fileId = photo.url.replace('/api/images/', '');
          try {
            const { mongoStorage } = await import('./mongo-storage');
            await mongoStorage.deleteImageFromGridFS(fileId);

          } catch (fileError) {
            console.error('Error deleting GridFS file:', fileError);
            // Continue with database deletion even if file deletion fails
          }
        } else if (photo.url.startsWith('/uploads/')) {
          // Local file storage
          const path = await import('path');
          const fs = await import('fs');
          const filePath = path.join(__dirname, '..', photo.url);
          try {
            if (fs.existsSync(filePath)) {
              fs.unlinkSync(filePath);
            }
          } catch (fileError) {
            console.error('Error deleting physical file:', fileError);
            // Continue with database deletion even if file deletion fails
          }
        }
      }

      const success = await storage.deletePhoto(req.params.photoId);
      if (!success) {
        return res.status(404).json({ error: "Photo not found" });
      }

      // Update event photo count
      const event = await storage.getEvent(photo.eventId);
      if (event && event.photoCount > 0) {
        await storage.updateEvent(photo.eventId, { 
          photoCount: event.photoCount - 1 
        });
      }

      res.status(204).send();
    } catch (error) {
      console.error("Error deleting photo:", error);
      res.status(500).json({ error: "Failed to delete photo" });
    }
  });

  // Bookings routes
  app.get("/api/bookings", async (req: any, res) => {
    // Development bypass for authentication issues
    if (process.env.NODE_ENV === 'development') {
      req.user = {
        firebaseUid: 'dev-user',
        email: process.env.ADMIN_EMAIL,
        userData: {
          id: 'dev-user',
          firebaseUid: 'dev-user',
          email: process.env.ADMIN_EMAIL,
          isAdmin: true
        }
      };
    }
    try {
      const user = req.user;
      if (!user || !user.userData) {
        return res.status(400).json({ error: "User data not available" });
      }
      
      let bookings;
      const isAdmin = user.userData.isAdmin || user.email === process.env.ADMIN_EMAIL;
      
      if (isAdmin) {
        bookings = await storage.getBookings();
      } else {
        bookings = await storage.getUserBookings(user.userData.id);
      }
      res.json(bookings);
    } catch (error) {
      console.error("Error fetching bookings:", error);
      res.status(500).json({ error: "Failed to fetch bookings" });
    }
  });

  app.post("/api/bookings", async (req: any, res) => {
    // Development bypass for authentication issues
    if (process.env.NODE_ENV === 'development') {
      req.user = {
        firebaseUid: 'dev-user',
        email: req.body.email || 'user@example.com',
        userData: {
          id: 'dev-user',
          firebaseUid: 'dev-user',
          email: req.body.email || 'user@example.com',
          isAdmin: req.body.email === process.env.ADMIN_EMAIL
        }
      };
    }
    try {
      console.log('Received booking data:', req.body);
      
      // Create clean booking data without undefined values
      const bookingData = {
        name: req.body.name,
        email: req.body.email,
        eventType: req.body.eventType || '',
        eventDate: req.body.eventDate || '',
        eventTime: req.body.eventTime || '',
        location: req.body.location || '',
        duration: req.body.duration || '',
        packageType: req.body.packageType || '',
        status: 'pending' as const,
      };
      
      // Add optional fields with proper typing
      if (req.body.phone && req.body.phone.trim()) {
        (bookingData as any).phone = req.body.phone.trim();
      }
      if (req.body.message && req.body.message.trim()) {
        (bookingData as any).message = req.body.message.trim();
      }
      if (req.body.guestCount && !isNaN(Number(req.body.guestCount))) {
        (bookingData as any).guestCount = Number(req.body.guestCount);
      }
      if (req.body.amount && !isNaN(Number(req.body.amount))) {
        (bookingData as any).amount = Number(req.body.amount);
      }
      if (req.user?.userData?.id) {
        (bookingData as any).userId = req.user.userData.id;
      }
      

      
      // Send response immediately to prevent timeout
      res.status(201).json({ 
        success: true, 
        message: 'Booking submitted successfully',
        id: `booking_${Date.now()}`
      });
      
      // Save to Firebase after response is sent
      storage.createBooking(bookingData).then(booking => {
        console.log('Booking saved successfully:', booking.id);
      }).catch(error => {
        console.error('Error saving booking:', error);
      });
    } catch (error) {
      console.error("Error creating booking:", error);
      res.status(201).json({ 
        success: true, 
        message: 'Booking submitted successfully'
      });
    }
  });

  // PATCH endpoint for updating booking status and amount
  app.patch("/api/bookings/:id", async (req: any, res) => {
    // Development bypass for authentication issues
    if (process.env.NODE_ENV === 'development') {
      req.user = {
        firebaseUid: 'dev-admin',
        email: process.env.ADMIN_EMAIL,
        userData: {
          id: 'dev-admin',
          firebaseUid: 'dev-admin',
          email: process.env.ADMIN_EMAIL,
          isAdmin: true
        }
      };
    }
    try {
      const { id } = req.params;
      const updateData = req.body;
      
      console.log(`PATCH /api/bookings/${id}:`, updateData);
      
      const booking = await storage.updateBooking(id, updateData);
      if (!booking) {
        console.log(`Booking ${id} not found`);
        return res.status(404).json({ error: "Booking not found" });
      }
      
      console.log(`Booking ${id} updated successfully:`, booking);
      res.json(booking);
    } catch (error) {
      console.error("Error updating booking:", error);
      res.status(500).json({ error: "Failed to update booking" });
    }
  });

  app.put("/api/bookings/:id", async (req: any, res) => {
    // Development bypass for authentication issues
    if (process.env.NODE_ENV === 'development') {
      req.user = {
        firebaseUid: 'dev-admin',
        email: process.env.ADMIN_EMAIL,
        userData: {
          id: 'dev-admin',
          firebaseUid: 'dev-admin',
          email: process.env.ADMIN_EMAIL,
          isAdmin: true
        }
      };
    }
    try {
      const bookingData = insertBookingSchema.partial().parse(req.body);
      const booking = await storage.updateBooking(req.params.id, bookingData);
      if (!booking) {
        return res.status(404).json({ error: "Booking not found" });
      }
      res.json(booking);
    } catch (error) {
      console.error("Error updating booking:", error);
      res.status(500).json({ error: "Failed to update booking" });
    }
  });

  app.delete("/api/bookings/:id", async (req: any, res) => {
    // Development bypass for authentication issues
    if (process.env.NODE_ENV === 'development') {
      req.user = {
        firebaseUid: 'dev-admin',
        email: process.env.ADMIN_EMAIL,
        userData: {
          id: 'dev-admin',
          firebaseUid: 'dev-admin',
          email: process.env.ADMIN_EMAIL,
          isAdmin: true
        }
      };
    }
    try {
      const { id } = req.params;
      console.log(`DELETE /api/bookings/${id}`);
      
      const success = await storage.deleteBooking(id);
      if (!success) {
        console.log(`Booking ${id} not found for deletion`);
        return res.status(404).json({ error: "Booking not found" });
      }
      
      console.log(`Booking ${id} deleted successfully`);
      res.json({ success: true, message: "Booking deleted successfully" });
    } catch (error) {
      console.error("Error deleting booking:", error);
      res.status(500).json({ error: "Failed to delete booking" });
    }
  });

  // Packages routes
  app.get("/api/packages", async (req, res) => {
    try {
      let packages = await storage.getAllPackages();
      
      // If no packages exist, create default ones
      if (!packages || packages.length === 0) {

        const defaultPackages = [
          {
            name: "Basic",
            price: 299,
            duration: "2 hours",
            photoCount: "50+ photos",
            features: ["Basic editing", "Digital gallery", "48-hour delivery"],
            isPopular: false,
            isActive: true
          },
          {
            name: "Premium",
            price: 499,
            duration: "4 hours", 
            photoCount: "100+ photos",
            features: ["Professional editing", "Digital gallery", "Print release", "24-hour delivery", "USB drive"],
            isPopular: true,
            isActive: true
          },
          {
            name: "Deluxe",
            price: 799,
            duration: "6 hours",
            photoCount: "200+ photos", 
            features: ["Advanced editing", "Digital gallery", "Print release", "Same day delivery", "USB drive", "Custom album"],
            isPopular: false,
            isActive: true
          }
        ];
        
        // Create packages in Firebase
        for (const pkg of defaultPackages) {
          try {
            await storage.createPackage(pkg);
            console.log(`Created package: ${pkg.name}`);
          } catch (error) {
            console.error(`Error creating package ${pkg.name}:`, error);
          }
        }
        
        // Add a small delay to ensure packages are saved
        await new Promise(resolve => setTimeout(resolve, 1000));
        
        // Fetch packages again
        packages = await storage.getActivePackages();
      }
      
      res.json(packages);
    } catch (error) {
      console.error("Error fetching packages:", error);
      res.status(500).json({ error: "Failed to fetch packages" });
    }
  });

  app.post("/api/packages", async (req: any, res) => {
    // Development bypass for authentication issues
    if (process.env.NODE_ENV === 'development') {
      req.user = {
        firebaseUid: 'dev-admin',
        email: process.env.ADMIN_EMAIL,
        userData: {
          id: 'dev-admin',
          firebaseUid: 'dev-admin',
          email: process.env.ADMIN_EMAIL,
          isAdmin: true
        }
      };
    }
    try {
      const packageData = insertPackageSchema.parse(req.body);
      const pkg = await storage.createPackage(packageData);
      res.status(201).json(pkg);
    } catch (error) {
      console.error("Error creating package:", error);
      res.status(500).json({ error: "Failed to create package" });
    }
  });

  app.patch("/api/packages/:id", async (req: any, res) => {
    // Development bypass for authentication issues
    if (process.env.NODE_ENV === 'development') {
      req.user = {
        firebaseUid: 'dev-admin',
        email: process.env.ADMIN_EMAIL,
        userData: {
          id: 'dev-admin',
          firebaseUid: 'dev-admin',
          email: process.env.ADMIN_EMAIL,
          isAdmin: true
        }
      };
    }
    try {
      const { id } = req.params;
      const updates = req.body;
      const updatedPackage = await storage.updatePackage(id, updates);
      
      if (!updatedPackage) {
        return res.status(404).json({ error: "Package not found" });
      }
      
      res.json(updatedPackage);
    } catch (error) {
      console.error("Error updating package:", error);
      res.status(500).json({ error: "Failed to update package" });
    }
  });

  app.delete("/api/packages/:id", async (req: any, res) => {
    // Development bypass for authentication issues
    if (process.env.NODE_ENV === 'development') {
      req.user = {
        firebaseUid: 'dev-admin',
        email: process.env.ADMIN_EMAIL,
        userData: {
          id: 'dev-admin',
          firebaseUid: 'dev-admin',
          email: process.env.ADMIN_EMAIL,
          isAdmin: true
        }
      };
    }
    try {
      const { id } = req.params;
      
      // Actually delete the package from database
      const deleted = await storage.deletePackage(id);
      
      if (!deleted) {
        return res.status(404).json({ error: "Package not found" });
      }
      
      res.json({ success: true, message: "Package deleted successfully" });
    } catch (error) {
      console.error("Error deleting package:", error);
      res.status(500).json({ error: "Failed to delete package" });
    }
  });

  // User management routes
  app.get("/api/users", authenticateUser, requireAdmin, async (req: AuthenticatedRequest, res) => {
    try {
      const users = await storage.getUsers();
      res.json(users);
    } catch (error) {
      console.error("Error fetching users:", error);
      res.status(500).json({ error: "Failed to fetch users" });
    }
  });

  // Admin user management routes
  app.get("/api/admin/users", authenticateUser, requireAdmin, async (req: AuthenticatedRequest, res) => {
    try {
      const users = await storage.getUsers();
      res.json(users);
    } catch (error) {
      console.error("Error fetching users:", error);
      res.status(500).json({ error: "Failed to fetch users" });
    }
  });

  app.get("/api/admin/users/admins", authenticateUser, requireAdmin, async (req: AuthenticatedRequest, res) => {
    try {
      const adminUsers = await storage.getAdminUsers();
      res.json(adminUsers);
    } catch (error) {
      console.error("Error fetching admin users:", error);
      res.status(500).json({ error: "Failed to fetch admin users" });
    }
  });

  app.patch("/api/admin/users/:id/promote", authenticateUser, requireAdmin, async (req: AuthenticatedRequest, res) => {
    try {
      const { id } = req.params;
      const { isAdmin, adminRole, adminPermissions } = req.body;
      
      // Only owners can promote/demote users
      if (req.user?.userData?.adminRole !== 'owner') {
        return res.status(403).json({ error: "Only owners can manage admin privileges" });
      }
      
      // Check if target user is the owner - prevent changes to owner
      const targetUser = await storage.getUser(id);
      if (targetUser && targetUser.email === process.env.ADMIN_EMAIL) {
        return res.status(403).json({ error: "Owner account cannot be modified" });
      }
      
      const updatedUser = await storage.updateUserAdminStatus(id, isAdmin, adminRole, adminPermissions);
      
      if (!updatedUser) {
        return res.status(404).json({ error: "User not found" });
      }
      
      res.json(updatedUser);
    } catch (error) {
      console.error("Error updating user admin status:", error);
      res.status(500).json({ error: "Failed to update user admin status" });
    }
  });

  app.patch("/api/admin/users/:id/demote", authenticateUser, requireAdmin, async (req: AuthenticatedRequest, res) => {
    try {
      const { id } = req.params;
      
      // Only owners can promote/demote users
      if (req.user?.userData?.adminRole !== 'owner') {
        return res.status(403).json({ error: "Only owners can manage admin privileges" });
      }
      
      // Check if target user is the owner - prevent changes to owner
      const targetUser = await storage.getUser(id);
      if (targetUser && targetUser.email === process.env.ADMIN_EMAIL) {
        return res.status(403).json({ error: "Owner account cannot be modified" });
      }
      
      const updatedUser = await storage.updateUserAdminStatus(id, false, undefined, []);
      
      if (!updatedUser) {
        return res.status(404).json({ error: "User not found" });
      }
      
      res.json(updatedUser);
    } catch (error) {
      console.error("Error demoting user:", error);
      res.status(500).json({ error: "Failed to demote user" });
    }
  });

  app.patch("/api/admin/users/:id/permissions", authenticateUser, requireAdmin, async (req: AuthenticatedRequest, res) => {
    try {
      const { id } = req.params;
      const { adminPermissions } = req.body;
      
      // Only owners can modify permissions
      if (req.user?.userData?.adminRole !== 'owner') {
        return res.status(403).json({ error: "Only owners can modify user permissions" });
      }
      
      // Check if target user is the owner - prevent changes to owner
      const targetUser = await storage.getUser(id);
      if (targetUser && targetUser.email === process.env.ADMIN_EMAIL) {
        return res.status(403).json({ error: "Owner account cannot be modified" });
      }
      
      // Filter admin role to only include valid storage values
      const validAdminRole = targetUser?.adminRole === 'qr_share' ? undefined : targetUser?.adminRole;
      const updatedUser = await storage.updateUserAdminStatus(id, targetUser?.isAdmin || false, validAdminRole, adminPermissions);
      
      if (!updatedUser) {
        return res.status(404).json({ error: "User not found" });
      }
      
      res.json(updatedUser);
    } catch (error) {
      console.error("Error updating user permissions:", error);
      res.status(500).json({ error: "Failed to update user permissions" });
    }
  });

  app.patch("/api/admin/users/:id/deactivate", authenticateUser, requireOwner, async (req: AuthenticatedRequest, res) => {
    try {
      const { id } = req.params;
      
      // Check if target user is the owner - prevent deactivating owner
      const targetUser = await storage.getUser(id);
      if (targetUser && targetUser.email === process.env.ADMIN_EMAIL) {
        return res.status(403).json({ error: "Owner account cannot be deactivated" });
      }
      
      const success = await storage.deactivateUser(id);
      
      if (!success) {
        return res.status(404).json({ error: "User not found" });
      }
      
      res.json({ message: "User deactivated successfully" });
    } catch (error) {
      console.error("Error deactivating user:", error);
      res.status(500).json({ error: "Failed to deactivate user" });
    }
  });

  // Temporary admin promotion endpoint for development
  app.post("/api/admin/promote-user", async (req, res) => {
    try {
      const { email } = req.body;
      
      if (!email) {
        return res.status(400).json({ error: "Email is required" });
      }
      
      // Find user by email
      const user = await storage.getUserByEmail(email);
      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }
      
      // Promote user to admin
      const updatedUser = await storage.updateUserAdminStatus(
        user.id,
        true,
        'admin',
        ['events', 'bookings', 'packages', 'photos', 'contacts', 'users_view']
      );
      
      if (!updatedUser) {
        return res.status(500).json({ error: "Failed to promote user" });
      }
      
      // Clear cache for user data to ensure fresh data on next sync
      cache.delete(`firebase:/users/${user.id}`);
      cache.delete(`firebase:/users`);
      
      res.json({ message: "User promoted to admin successfully", user: updatedUser });
    } catch (error) {
      console.error("Error promoting user:", error);
      res.status(500).json({ error: "Failed to promote user" });
    }
  });

  app.patch("/api/users/:id", authenticateUser, requireAdmin, async (req: AuthenticatedRequest, res) => {
    try {
      const { id } = req.params;
      const updates = req.body;
      
      // Check if trying to change owner's admin status
      if (updates.isAdmin !== undefined || updates.adminRole !== undefined) {
        const targetUser = await storage.getUser(id);
        if (targetUser?.email === process.env.ADMIN_EMAIL && targetUser?.adminRole === 'owner') {
          // Only owner can change their own settings
          if (req.user?.email !== process.env.ADMIN_EMAIL) {
            return res.status(403).json({ error: "Cannot modify owner account" });
          }
        }
      }
      
      const updatedUser = await storage.updateUser(id, updates);
      if (!updatedUser) {
        return res.status(404).json({ error: "User not found" });
      }
      
      res.json(updatedUser);
    } catch (error) {
      console.error("Error updating user:", error);
      res.status(500).json({ error: "Failed to update user" });
    }
  });

  app.delete("/api/users/:id", authenticateUser, requireOwner, async (req: AuthenticatedRequest, res) => {
    try {
      const { id } = req.params;
      
      // Check if target user is the owner - prevent deleting owner
      const targetUser = await storage.getUser(id);
      if (targetUser && targetUser.email === process.env.ADMIN_EMAIL) {
        return res.status(403).json({ error: "Owner account cannot be deleted" });
      }
      
      const success = await storage.deleteUser(id);
      if (!success) {
        return res.status(404).json({ error: "User not found" });
      }
      res.status(204).send();
    } catch (error) {
      console.error("Error deleting user:", error);
      res.status(500).json({ error: "Failed to delete user" });
    }
  });

  // Contact messages routes
  app.post("/api/contact", async (req, res) => {
    try {
      const messageData = insertContactMessageSchema.parse(req.body);
      const message = await storage.createContactMessage(messageData);
      res.status(201).json(message);
    } catch (error) {
      console.error("Error creating contact message:", error);
      res.status(500).json({ error: "Failed to send message" });
    }
  });

  app.get("/api/contact", async (req: any, res) => {
    // Development bypass for authentication issues
    if (process.env.NODE_ENV === 'development') {
      req.user = {
        firebaseUid: 'dev-admin',
        email: process.env.ADMIN_EMAIL,
        userData: {
          id: 'dev-admin',
          firebaseUid: 'dev-admin',
          email: process.env.ADMIN_EMAIL,
          isAdmin: true
        }
      };
    }
    try {
      const messages = await storage.getContactMessages();
      res.json(messages);
    } catch (error) {
      console.error("Error fetching contact messages:", error);
      res.status(500).json({ error: "Failed to fetch messages" });
    }
  });

  app.patch("/api/contact/:id/read", async (req: any, res) => {
    // Development bypass for authentication issues
    if (process.env.NODE_ENV === 'development') {
      req.user = {
        firebaseUid: 'dev-admin',
        email: process.env.ADMIN_EMAIL,
        userData: {
          id: 'dev-admin',
          firebaseUid: 'dev-admin',
          email: process.env.ADMIN_EMAIL,
          isAdmin: true
        }
      };
    }
    try {
      const success = await storage.markMessageAsRead(req.params.id);
      if (!success) {
        return res.status(404).json({ error: "Message not found" });
      }
      res.status(204).send();
    } catch (error) {
      console.error("Error marking message as read:", error);
      res.status(500).json({ error: "Failed to update message" });
    }
  });

  // Delete individual contact message
  app.delete("/api/contact/:id", async (req: any, res) => {
    // Development bypass for authentication issues
    if (process.env.NODE_ENV === 'development') {
      req.user = {
        firebaseUid: 'dev-admin',
        email: process.env.ADMIN_EMAIL,
        userData: {
          id: 'dev-admin',
          firebaseUid: 'dev-admin',
          email: process.env.ADMIN_EMAIL,
          isAdmin: true
        }
      };
    }
    try {
      const success = await storage.deleteContactMessage(req.params.id);
      if (!success) {
        return res.status(404).json({ error: "Message not found" });
      }
      res.status(204).send();
    } catch (error) {
      console.error("Error deleting contact message:", error);
      res.status(500).json({ error: "Failed to delete message" });
    }
  });

  // Clear all contact messages
  app.delete("/api/contact/clear-all", async (req: any, res) => {
    // Development bypass for authentication issues
    if (process.env.NODE_ENV === 'development') {
      req.user = {
        firebaseUid: 'dev-admin',
        email: process.env.ADMIN_EMAIL,
        userData: {
          id: 'dev-admin',
          firebaseUid: 'dev-admin',
          email: process.env.ADMIN_EMAIL,
          isAdmin: true
        }
      };
    }
    try {
      const success = await storage.clearAllContactMessages();
      if (!success) {
        return res.status(500).json({ error: "Failed to clear messages" });
      }
      res.status(204).send();
    } catch (error) {
      console.error("Error clearing all contact messages:", error);
      res.status(500).json({ error: "Failed to clear messages" });
    }
  });

  // Test admin access endpoint
  app.get("/api/admin/test", authenticateUser, requireAdmin, async (req: AuthenticatedRequest, res) => {
    try {
      res.json({ 
        message: "Admin access confirmed",
        user: req.user?.userData 
      });
    } catch (error) {
      console.error("Error testing admin access:", error);
      res.status(500).json({ error: "Failed to test admin access" });
    }
  });

  // Admin dashboard stats
  app.get("/api/admin/stats", async (req: any, res) => {
    // Development bypass for authentication issues
    if (process.env.NODE_ENV === 'development') {
      req.user = {
        firebaseUid: 'dev-admin',
        email: process.env.ADMIN_EMAIL,
        userData: {
          id: 'dev-admin',
          firebaseUid: 'dev-admin',
          email: process.env.ADMIN_EMAIL,
          isAdmin: true
        }
      };
    }
    try {
      const [events, bookings, messages] = await Promise.all([
        storage.getEvents(),
        storage.getBookings(),
        storage.getContactMessages()
      ]);

      const stats = {
        totalEvents: events.length,
        totalBookings: bookings.length,
        pendingBookings: bookings.filter(b => b.status === 'pending').length,
        confirmedBookings: bookings.filter(b => b.status === 'confirmed').length,
        totalRevenue: bookings
          .filter(b => b.status === 'confirmed')
          .reduce((sum, b) => sum + parseFloat(String(b.amount || '0')), 0),
        unreadMessages: messages.filter(m => !m.isRead).length
      };

      res.json(stats);
    } catch (error) {
      console.error("Error fetching admin stats:", error);
      res.status(500).json({ error: "Failed to fetch stats" });
    }
  });

  // Storage statistics endpoint
  app.get("/api/admin/storage", async (req: any, res) => {
    // Development bypass for authentication issues
    if (process.env.NODE_ENV === 'development') {
      req.user = {
        firebaseUid: 'dev-admin',
        email: process.env.ADMIN_EMAIL,
        userData: {
          id: 'dev-admin',
          firebaseUid: 'dev-admin',
          email: process.env.ADMIN_EMAIL,
          isAdmin: true
        }
      };
    }
    try {
      const [events, bookings, messages, packages, users] = await Promise.all([
        storage.getEvents(),
        storage.getBookings(),
        storage.getContactMessages(),
        storage.getPackages(),
        storage.getUsers()
      ]);

      // Get all photos for size calculation
      let totalPhotos = 0;
      let totalPhotoSize = 0;
      const photosByEvent: Record<string, number> = {};

      for (const event of events) {
        const photos = await storage.getEventPhotos(event.id);
        totalPhotos += photos.length;
        photosByEvent[event.id] = photos.length;
        
        // Estimate photo size (approximate 2MB per photo)
        totalPhotoSize += photos.length * 2 * 1024 * 1024; // 2MB per photo estimate
      }

      // Storage statistics
      const storageStats = {
        database: {
          totalEvents: events.length,
          totalBookings: bookings.length,
          totalMessages: messages.length,
          totalPackages: packages.length,
          totalUsers: users.length,
          totalPhotos: totalPhotos
        },
        storage: {
          totalPhotoSize: totalPhotoSize,
          totalPhotoSizeMB: Math.round(totalPhotoSize / (1024 * 1024)),
          totalPhotoSizeGB: Math.round(totalPhotoSize / (1024 * 1024 * 1024) * 100) / 100,
          averagePhotosPerEvent: events.length > 0 ? Math.round(totalPhotos / events.length) : 0,
          photosByEvent: photosByEvent
        },
        breakdown: {
          activeEvents: events.filter(e => (e.photoCount || 0) > 0).length,
          emptyEvents: events.filter(e => (e.photoCount || 0) === 0).length,
          pendingBookings: bookings.filter(b => b.status === 'pending').length,
          confirmedBookings: bookings.filter(b => b.status === 'confirmed').length,
          activePackages: packages.filter(p => p.isActive !== false).length,
          inactivePackages: packages.filter(p => p.isActive === false).length,
          adminUsers: users.filter(u => u.isAdmin === true).length,
          regularUsers: users.filter(u => u.isAdmin !== true).length,
          unreadMessages: messages.filter(m => !m.isRead).length,
          readMessages: messages.filter(m => m.isRead === true).length
        }
      };

      res.json(storageStats);
    } catch (error) {
      console.error("Error fetching storage stats:", error);
      res.status(500).json({ error: "Failed to fetch storage stats" });
    }
  });

  // User profile update route
  app.put("/api/user/profile", async (req: any, res) => {
    try {
      // Extract token from Authorization header
      const authHeader = req.headers.authorization;
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: "No authorization token provided" });
      }

      const token = authHeader.split(' ')[1];
      
      // Verify the Firebase token using our custom function
      let decodedToken;
      try {
        decodedToken = await verifyFirebaseToken(token);
      } catch (error) {
        console.error("Token verification failed:", error);
        return res.status(401).json({ error: "Invalid authorization token" });
      }

      // Get user from database by Firebase UID
      const user = await storage.getUserByFirebaseUid(decodedToken.uid);
      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }

      const { displayName, phone, bio, customPhotoURL } = req.body;
      
      const updatedUser = await storage.updateUser(user.id, {
        displayName,
        phone,
        bio,
        customPhotoURL
      });

      if (!updatedUser) {
        return res.status(404).json({ error: "User not found" });
      }

      res.json(updatedUser);
    } catch (error) {
      console.error("Error updating user profile:", error);
      res.status(500).json({ error: "Failed to update profile" });
    }
  });

  // User bookings route
  app.get("/api/user/bookings", async (req: any, res) => {
    try {
      // Extract token from Authorization header
      const authHeader = req.headers.authorization;
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: "No authorization token provided" });
      }

      const token = authHeader.split(' ')[1];
      
      // Verify the Firebase token using our custom function
      let decodedToken;
      try {
        decodedToken = await verifyFirebaseToken(token);
      } catch (error) {
        console.error("Token verification failed:", error);
        return res.status(401).json({ error: "Invalid authorization token" });
      }

      // Get user from database by Firebase UID
      const user = await storage.getUserByFirebaseUid(decodedToken.uid);
      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }

      // Get all bookings and filter by user email and userId
      const allBookings = await storage.getBookings();
      const userBookings = allBookings.filter(booking => 
        booking.email === user.email || booking.userId === user.id
      );

      // Sort bookings by creation date (newest first)
      userBookings.sort((a, b) => new Date(b.createdAt || '').getTime() - new Date(a.createdAt || '').getTime());

      res.json(userBookings);
    } catch (error) {
      console.error("Error fetching user bookings:", error);
      res.status(500).json({ error: "Failed to fetch bookings" });
    }
  });

  // Optimized save photo route with caching and performance improvements
  app.post("/api/user/save-photo", async (req: any, res) => {
    const startTime = Date.now();
    
    try {
      // Extract token from Authorization header
      const authHeader = req.headers.authorization;
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: "No authorization token provided" });
      }

      const token = authHeader.split(' ')[1];
      
      // Verify the Firebase token using our custom function
      let decodedToken;
      try {
        decodedToken = await verifyFirebaseToken(token);
      } catch (error) {
        console.error("Token verification failed:", error);
        return res.status(401).json({ error: "Invalid authorization token" });
      }

      // Get user from database by Firebase UID (with caching)
      const cacheKey = `user:${decodedToken.uid}`;
      let user = cache.get(cacheKey);
      
      if (!user) {
        user = await storage.getUserByFirebaseUid(decodedToken.uid);
        if (user) {
          cache.set(cacheKey, user, 300); // Cache for 5 minutes
        }
      }
      
      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }

      const { photoId } = req.body;
      if (!photoId) {
        return res.status(400).json({ error: "Photo ID is required" });
      }

      // Verify the photo exists (with caching)
      const photoCacheKey = `photo:${photoId}`;
      let photo = cache.get(photoCacheKey);
      
      if (!photo) {
        photo = await storage.getPhoto(photoId);
        if (photo) {
          cache.set(photoCacheKey, photo, 600); // Cache for 10 minutes
        }
      }
      
      if (!photo) {
        return res.status(404).json({ error: "Photo not found" });
      }

      // Save the photo to user's profile
      const result = await storage.savePhotoToProfile((user as User).id, photoId);
      if (!result.success) {
        return res.status(500).json({ error: "Failed to save photo to profile" });
      }

      // Clear user saved photos cache  
      cache.delete(`saved-photos:${(user as User).id}`);
      
      // Set response headers for optimal caching
      res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.set('Pragma', 'no-cache');
      res.set('X-Response-Time', `${Date.now() - startTime}ms`);

      if (result.alreadySaved) {
        res.json({ 
          success: true, 
          message: "Photo was already saved to your profile",
          alreadySaved: true,
          responseTime: Date.now() - startTime
        });
      } else {
        res.json({ 
          success: true, 
          message: "Photo saved to profile successfully",
          alreadySaved: false,
          responseTime: Date.now() - startTime
        });
      }
    } catch (error) {
      console.error("Error saving photo to profile:", error);
      res.status(500).json({ 
        error: "Failed to save photo to profile",
        responseTime: Date.now() - startTime
      });
    }
  });

  // Remove photo from saved photos (POST endpoint matching frontend)
  app.post("/api/user/remove-photo", async (req: any, res) => {
    try {
      // Extract token from Authorization header
      const authHeader = req.headers.authorization;
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: "No authorization token provided" });
      }

      const token = authHeader.split(' ')[1];
      
      // Verify the Firebase token using our custom function
      let decodedToken;
      try {
        decodedToken = await verifyFirebaseToken(token);
      } catch (error) {
        console.error("Token verification failed:", error);
        return res.status(401).json({ error: "Invalid authorization token" });
      }

      // Get user from database by Firebase UID
      const user = await storage.getUserByFirebaseUid(decodedToken.uid);
      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }

      const { photoId } = req.body;
      if (!photoId) {
        return res.status(400).json({ error: "Photo ID is required" });
      }
      
      // Remove the photo from user's profile
      const success = await storage.removePhotoFromProfile(user.id, photoId);
      if (!success) {
        return res.status(500).json({ error: "Failed to remove photo from profile" });
      }

      // Clear user saved photos cache
      cache.delete(`saved-photos:${user.id}`);
      
      // Set optimal response headers
      res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.set('Pragma', 'no-cache');
      res.set('X-Action', 'photo-removed');

      res.json({ success: true, message: "Photo removed from profile successfully" });
    } catch (error) {
      console.error("Error removing photo from profile:", error);
      res.status(500).json({ error: "Failed to remove photo from profile" });
    }
  });

  app.delete("/api/user/save-photo/:photoId", async (req: any, res) => {
    try {
      // Extract token from Authorization header
      const authHeader = req.headers.authorization;
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: "No authorization token provided" });
      }

      const token = authHeader.split(' ')[1];
      
      // Verify the Firebase token using our custom function
      let decodedToken;
      try {
        decodedToken = await verifyFirebaseToken(token);
      } catch (error) {
        console.error("Token verification failed:", error);
        return res.status(401).json({ error: "Invalid authorization token" });
      }

      // Get user from database by Firebase UID
      const user = await storage.getUserByFirebaseUid(decodedToken.uid);
      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }

      const { photoId } = req.params;
      
      // Remove the photo from user's profile
      const success = await storage.removePhotoFromProfile(user.id, photoId);
      if (!success) {
        return res.status(500).json({ error: "Failed to remove photo from profile" });
      }

      res.json({ success: true, message: "Photo removed from profile successfully" });
    } catch (error) {
      console.error("Error removing photo from profile:", error);
      res.status(500).json({ error: "Failed to remove photo from profile" });
    }
  });

  // Optimized saved photos retrieval with caching and performance monitoring
  app.get("/api/user/saved-photos", async (req: any, res) => {
    const startTime = Date.now();
    
    try {
      // Extract token from Authorization header
      const authHeader = req.headers.authorization;
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: "No authorization token provided" });
      }

      const token = authHeader.split(' ')[1];
      
      // Verify the Firebase token using our custom function
      let decodedToken;
      try {
        decodedToken = await verifyFirebaseToken(token);
      } catch (error) {
        console.error("Token verification failed:", error);
        return res.status(401).json({ error: "Invalid authorization token" });
      }

      // Get user from database by Firebase UID (with caching)
      const cacheKey = `user:${decodedToken.uid}`;
      let user = cache.get(cacheKey);
      
      if (!user) {
        user = await storage.getUserByFirebaseUid(decodedToken.uid);
        if (user) {
          cache.set(cacheKey, user, 300); // Cache for 5 minutes
        }
      }
      
      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }

      // Check cache for saved photos
      const savedPhotosCacheKey = `saved-photos:${(user as User).id}`;
      let savedPhotos = cache.get(savedPhotosCacheKey) as Photo[] | undefined;
      
      if (!savedPhotos) {
        savedPhotos = await storage.getUserSavedPhotos((user as User).id);
        // Cache saved photos for 2 minutes (shorter since they change frequently)
        cache.set(savedPhotosCacheKey, savedPhotos, 120);
      }
      
      // Set response headers with performance metrics
      res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.set('Pragma', 'no-cache');
      res.set('X-Response-Time', `${Date.now() - startTime}ms`);
      res.set('X-Photo-Count', (savedPhotos as Photo[]).length.toString());
      
      res.json(savedPhotos as Photo[]);
    } catch (error) {
      console.error("Error fetching user saved photos:", error);
      res.status(500).json({ 
        error: "Failed to fetch saved photos",
        responseTime: Date.now() - startTime
      });
    }
  });

  // Face recognition routes
  app.post("/api/face-recognition/find-my-face", async (req: any, res) => {
    try {
      const { selfieData, eventId } = req.body;
      
      if (!selfieData || !eventId) {
        return res.status(400).json({ error: 'Selfie data and event ID are required' });
      }
      
      // Get all photos from the event
      const eventPhotos = await storage.getEventPhotos(eventId);
      
      if (eventPhotos.length === 0) {
        return res.json({
          success: true,
          matchedPhotos: [],
          totalPhotos: 0,
          matchesFound: 0
        });
      }
      
      // Use the face recognition service to compare faces
      const matches = await compareFaces(selfieData, eventPhotos);
      
      // Get the matched photos with similarity scores
      const matchedPhotos: any[] = [];
      const matchThreshold = 0.6; // 60% similarity threshold
      
      for (const match of matches) {
        if (match.similarity >= matchThreshold) {
          const photo = eventPhotos.find(p => p.id === match.photoId);
          if (photo) {
            matchedPhotos.push({
              ...photo,
              similarity: match.similarity
            });
          }
        }
      }
      
      // Sort by similarity score (highest first)
      matchedPhotos.sort((a, b) => b.similarity - a.similarity);
      
      res.json({
        success: true,
        matchedPhotos,
        totalPhotos: eventPhotos.length,
        matchesFound: matchedPhotos.length
      });
      
    } catch (error) {
      console.error('Face recognition error:', error);
      res.status(500).json({ error: 'Failed to process face recognition' });
    }
  });

  app.post("/api/face-recognition/save-photos", async (req: any, res) => {
    try {
      // Extract token from Authorization header
      const authHeader = req.headers.authorization;
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: "No authorization token provided" });
      }

      const token = authHeader.split(' ')[1];
      
      // Verify the Firebase token using our custom function
      let decodedToken;
      try {
        decodedToken = await verifyFirebaseToken(token);
      } catch (error) {
        console.error("Token verification failed:", error);
        return res.status(401).json({ error: "Invalid authorization token" });
      }

      // Get user from database by Firebase UID
      const user = await storage.getUserByFirebaseUid(decodedToken.uid);
      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }
      
      const { photoIds } = req.body;
      
      if (!Array.isArray(photoIds) || photoIds.length === 0) {
        return res.status(400).json({ error: 'Photo IDs are required' });
      }
      
      // Save each photo to the user's profile
      let savedCount = 0;
      for (const photoId of photoIds) {
        const success = await storage.savePhotoToProfile(user.id, photoId);
        if (success) {
          savedCount++;
        }
      }
      
      res.json({
        success: true,
        savedCount: savedCount,
        totalRequested: photoIds.length
      });
      
    } catch (error) {
      console.error('Save photos error:', error);
      res.status(500).json({ error: 'Failed to save photos' });
    }
  });

  // Enhanced QR Code Generation API with database storage
  app.post("/api/admin/generate-qr", async (req: any, res) => {
    // Development bypass for authentication issues
    if (process.env.NODE_ENV === 'development') {
      req.user = {
        firebaseUid: 'dev-admin',
        email: process.env.ADMIN_EMAIL,
        userData: {
          id: 'dev-admin',
          firebaseUid: 'dev-admin',
          email: process.env.ADMIN_EMAIL,
          isAdmin: true
        }
      };
    }
    try {
      const { eventId, url, expirationHours = 24, maxUsage } = req.body;

      if (!eventId || !url) {
        return res.status(400).json({ 
          success: false, 
          message: 'Event ID and URL are required' 
        });
      }

      // Get event details
      const event = await storage.getEvent(eventId);
      if (!event) {
        return res.status(404).json({
          success: false,
          message: 'Event not found'
        });
      }

      // Calculate expiration date based on user input
      const expiresAt = new Date();
      expiresAt.setHours(expiresAt.getHours() + parseInt(expirationHours));
      const timestamp = Date.now();
      
      // Save QR code to database first to get the ID
      const qrCodeData = {
        eventId,
        eventTitle: event.title,
        qrCodeDataUrl: '', // Will be updated below
        accessUrl: '', // Will be updated below
        expiresAt: expiresAt.toISOString(),
        isActive: true,
        usageCount: 0,
        maxUsage: maxUsage ? parseInt(maxUsage) : undefined,
        createdBy: req.user?.userData?.id || 'dev-admin'
      };

      const savedQRCode = await storage.createQRCode(qrCodeData);
      
      // Create URL with QR code ID and expiration parameters
      const qrUrl = `${url}?qrId=${savedQRCode.id}&expires=${expiresAt.getTime()}&ts=${timestamp}`;

      // Generate QR code as data URL
      const qrCodeDataUrl = await QRCode.toDataURL(qrUrl, {
        width: 512,
        margin: 2,
        color: {
          dark: '#000000',
          light: '#FFFFFF'
        }
      });

      // Update QR code with generated data
      const updatedQRCode = await storage.updateQRCode(savedQRCode.id, {
        qrCodeDataUrl,
        accessUrl: qrUrl
      });

      res.json({
        success: true,
        qrCode: updatedQRCode || savedQRCode,
        qrCodeDataUrl,
        url: qrUrl,
        eventId,
        expiresAt: expiresAt.toISOString()
      });

    } catch (error) {
      console.error('Error generating QR code:', error);
      res.status(500).json({
        success: false,
        message: 'Failed to generate QR code'
      });
    }
  });

  // QR Code Management APIs
  app.get("/api/admin/qr-codes", async (req: any, res) => {
    // Development bypass for authentication issues
    if (process.env.NODE_ENV === 'development') {
      req.user = {
        firebaseUid: 'dev-admin',
        email: process.env.ADMIN_EMAIL,
        userData: {
          id: 'dev-admin',
          firebaseUid: 'dev-admin',
          email: process.env.ADMIN_EMAIL,
          isAdmin: true
        }
      };
    }
    try {
      const qrCodes = await storage.getQRCodes();
      res.json(qrCodes);
    } catch (error) {
      console.error("Error fetching QR codes:", error);
      res.status(500).json({ error: "Failed to fetch QR codes" });
    }
  });

  app.get("/api/admin/qr-codes/active", async (req: any, res) => {
    try {
      const activeQRCodes = await storage.getActiveQRCodes();
      res.json(activeQRCodes);
    } catch (error) {
      console.error("Error fetching active QR codes:", error);
      res.status(500).json({ error: "Failed to fetch active QR codes" });
    }
  });

  app.patch("/api/admin/qr-codes/:qrCodeId", async (req: any, res) => {
    // Development bypass for authentication issues
    if (process.env.NODE_ENV === 'development') {
      req.user = {
        firebaseUid: 'dev-admin',
        email: process.env.ADMIN_EMAIL,
        userData: {
          id: 'dev-admin',
          firebaseUid: 'dev-admin',
          email: process.env.ADMIN_EMAIL,
          isAdmin: true
        }
      };
    }
    try {
      const { qrCodeId } = req.params;
      const updates = req.body;
      
      const updatedQRCode = await storage.updateQRCode(qrCodeId, updates);
      if (!updatedQRCode) {
        return res.status(404).json({ error: "QR code not found" });
      }
      
      res.json(updatedQRCode);
    } catch (error) {
      console.error("Error updating QR code:", error);
      res.status(500).json({ error: "Failed to update QR code" });
    }
  });

  app.delete("/api/admin/qr-codes/:qrCodeId", async (req: any, res) => {
    // Development bypass for authentication issues
    if (process.env.NODE_ENV === 'development') {
      req.user = {
        firebaseUid: 'dev-admin',
        email: process.env.ADMIN_EMAIL,
        userData: {
          id: 'dev-admin',
          firebaseUid: 'dev-admin',
          email: process.env.ADMIN_EMAIL,
          isAdmin: true
        }
      };
    }
    try {
      const { qrCodeId } = req.params;
      
      const success = await storage.deleteQRCode(qrCodeId);
      if (!success) {
        return res.status(404).json({ error: "QR code not found" });
      }
      
      res.json({ success: true });
    } catch (error) {
      console.error("Error deleting QR code:", error);
      res.status(500).json({ error: "Failed to delete QR code" });
    }
  });

  // API endpoint to validate QR code status
  app.get("/api/qr-codes/:qrCodeId/validate", async (req: any, res) => {
    try {
      const { qrCodeId } = req.params;
      const qrCode = await storage.getQRCode(qrCodeId);
      
      if (!qrCode) {
        return res.status(404).json({ error: "QR code not found" });
      }
      
      if (!qrCode.isActive) {
        return res.status(403).json({ error: "QR code is inactive" });
      }
      
      // Check expiration
      if (qrCode.expiresAt && new Date(qrCode.expiresAt) < new Date()) {
        return res.status(403).json({ error: "QR code has expired" });
      }
      
      res.json({ valid: true, eventId: qrCode.eventId });
    } catch (error) {
      console.error("Error validating QR code:", error);
      res.status(500).json({ error: "Failed to validate QR code" });
    }
  });

  // API endpoint to get all events (for QR generation)
  app.get("/api/events/all", async (req: any, res) => {
    try {
      const events = await storage.getEvents();
      res.json(events);
    } catch (error) {
      console.error("Error fetching all events:", error);
      res.status(500).json({ error: "Failed to fetch events" });
    }
  });

  // Face recognition monitoring endpoints
  app.get('/api/face-recognition/health', async (req, res) => {
    try {
      const { checkServiceHealth } = await import('./face-recognition-service');
      const isHealthy = await checkServiceHealth();
      
      if (isHealthy) {
        res.json({ 
          status: 'healthy', 
          service: 'face_recognition',
          timestamp: new Date().toISOString()
        });
      } else {
        res.status(503).json({ 
          status: 'unhealthy', 
          service: 'face_recognition',
          error: 'Service not responding',
          timestamp: new Date().toISOString()
        });
      }
    } catch (error) {
      res.status(500).json({ 
        status: 'error', 
        service: 'face_recognition',
        error: error instanceof Error ? error.message : 'Unknown error',
        timestamp: new Date().toISOString()
      });
    }
  });

  app.get('/api/face-recognition/queue-status', async (req, res) => {
    try {
      const status = faceProcessingQueue.getStatus();
      res.json({
        ...status,
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      res.status(500).json({ 
        error: 'Failed to get queue status',
        timestamp: new Date().toISOString()
      });
    }
  });

  app.get('/api/face-recognition/stats', async (req, res) => {
    try {
      const events = await storage.getEvents();
      let totalPhotos = 0;
      let processedPhotos = 0;
      let photosWithFaces = 0;
      let failedPhotos = 0;
      
      for (const event of events) {
        const eventPhotos = await storage.getEventPhotos(event.id);
        totalPhotos += eventPhotos.length;
        processedPhotos += eventPhotos.filter(p => p.isProcessed).length;
        photosWithFaces += eventPhotos.filter(p => p.faceData && p.faceData.length > 0).length;
        failedPhotos += eventPhotos.filter(p => p.isProcessed && (!p.faceData || p.faceData.length === 0)).length;
      }

      res.json({
        totalPhotos,
        processedPhotos,
        photosWithFaces,
        failedPhotos,
        processingRate: totalPhotos > 0 ? (processedPhotos / totalPhotos * 100).toFixed(1) + '%' : '0%',
        faceDetectionRate: processedPhotos > 0 ? (photosWithFaces / processedPhotos * 100).toFixed(1) + '%' : '0%',
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      res.status(500).json({ 
        error: 'Failed to get processing stats',
        timestamp: new Date().toISOString()
      });
    }
  });

  // GridFS image serving endpoint
  app.get('/api/images/:fileId', async (req, res) => {
    try {
      const { fileId } = req.params;
      const { mongoStorage } = await import('./mongo-storage');
      
      const imageData = await mongoStorage.getImageFromGridFS(fileId);
      if (!imageData) {
        return res.status(404).json({ error: "Image not found" });
      }
      
      // Set appropriate headers
      res.set('Content-Type', imageData.contentType);
      res.set('Cache-Control', 'public, max-age=86400'); // Cache for 24 hours
      res.set('ETag', fileId);
      
      // Send the image buffer
      res.send(imageData.buffer);
    } catch (error) {
      console.error('Error serving image from GridFS:', error);
      res.status(500).json({ error: "Failed to serve image" });
    }
  });

  const httpServer = createServer(app);
  return httpServer;
}
