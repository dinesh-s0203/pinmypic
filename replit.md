# PinMyPic - Photography Portfolio & Booking Platform

## Overview
PinMyPic is an AI-powered photography portfolio and booking platform designed for photographers to showcase their work, manage events, and handle bookings. Its key innovation is the "FindMyFace" service, utilizing AI-powered face recognition to allow clients to easily locate and retrieve their photos from event galleries. The platform aims to provide a modern, streamlined experience for both photographers and their clients, leveraging cutting-edge technology for efficient photo management and delivery.

## User Preferences
- Primary authentication method: Google OAuth only (integrated in nav header)
- Database-driven content (no static/mock data)
- Modern, clean UI design
- Secure client/server separation
- Streamlined UX with minimal authentication steps

## System Architecture
The platform is built with a decoupled frontend and backend.
- **Frontend**: Developed with React and TypeScript for dynamic user interfaces, styled using Tailwind CSS for utility-first styling, and enhanced with Radix UI components for accessible and customizable UI primitives.
- **Backend**: Implemented using Express.js with TypeScript, providing a robust API layer.
- **Data Storage**: MongoDB Atlas serves as the primary database for all application data, including event metadata, user information, bookings, and image metadata. MongoDB GridFS is used for efficient storage and serving of high-resolution images, with Cloudinary integrated as the primary cloud storage solution offering advanced image optimization and delivery, and a fallback system to MongoDB GridFS and local file system.
- **Authentication**: Firebase Authentication handles user authentication, specifically utilizing Google OAuth for streamlined login.
- **Image Processing**: A Python AI service, leveraging InsightFace for face recognition, processes images to extract face embeddings. This service runs asynchronously in the background.
- **Deployment**: The entire application is designed to run within a Replit environment.

**Key Technical Implementations & Design Decisions:**
- **AI-Powered FindMyFace**: Integrates a Python Flask service for real-time face recognition, extracting face embeddings (with bounding boxes and confidence scores) stored in MongoDB. It supports both webcam capture and photo uploads for client-side face matching against event galleries.
- **Comprehensive Image Management**: Supports large batch photo uploads (up to 10GB total, 100MB per file), with automatic processing for face recognition, image compression (WebP conversion, quality optimization), and original quality downloads. Includes features like thumbnail selection and efficient gallery display with virtualization and pagination.
- **Online Booking System**: Enables clients to book photography packages, with detailed booking management for admins (accept/reject/delete, amount editing).
- **Event Management**: Full CRUD operations for events, including dual PIN access (Public PIN for face recognition, Bride-Groom PIN for direct access) and QR-based event access with expiration.
- **User & Role Management**: Implements a robust role-based access control system (Owner, Admin, Moderator, QR Share) with granular permissions, secure user promotion/demotion, and user-friendly sorting in the admin dashboard.
- **Performance Optimizations**: Features include in-memory caching for API responses, parallel data fetching, lazy loading for images and pages, virtualized scrolling for galleries, image preloading, and optimized server payload limits.
- **Photo Interaction**: Full-screen photo viewer with zoom, pan, like/unlike, and download functionalities. "Save to Profile" allows users to collect favorite photos, with bulk download as ZIP.
- **Security**: All secrets are managed via environment variables, and email uniqueness is enforced at the application level to prevent duplicate user accounts.
- **UI/UX**: Modern, clean design using Tailwind CSS and Radix UI. Consistent fullscreen viewer experience. Responsive design and intuitive workflows across the platform. Image display is optimized for performance, providing compressed versions for display while preserving original quality for downloads.

## External Dependencies
- **Cloudinary**: Primary cloud storage for images, handling automatic optimization and delivery.
- **MongoDB Atlas**: Cloud-hosted NoSQL database for all application data.
- **Firebase Authentication**: Provides secure user authentication, specifically for Google OAuth.
- **Firebase Storage**: Used for assets and previous photo storage, though superseded by MongoDB GridFS and Cloudinary.
- **Python Flask (InsightFace)**: Dedicated microservice for AI-powered face recognition.
- **JSZip**: Library used for client-side ZIP compression for bulk photo downloads.
- **Sharp**: Node.js image processing library used server-side for image compression and optimization.