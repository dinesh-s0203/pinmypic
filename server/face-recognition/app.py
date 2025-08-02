"""
Flask API for face recognition processing.
"""
import os
import json
import sys
import time
import threading
from flask import Flask, request, jsonify
import numpy as np
import cv2
import base64
import requests
import io
from face_processor import FaceProcessor
import logging

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = Flask(__name__)
face_processor = None

# Connection pool for better performance
MAX_WORKERS = 2
processing_semaphore = None

def init_semaphore():
    """Initialize semaphore for controlling concurrent processing."""
    global processing_semaphore
    if processing_semaphore is None:
        processing_semaphore = __import__('asyncio').Semaphore(MAX_WORKERS)

def download_models_if_needed():
    """Download models before starting the face processor."""
    try:
        logger.info("Checking for face recognition models...")
        
        # Import and initialize to trigger model download
        import insightface
        from config import ARCFACE_MODEL_NAME
        
        # Create a temporary face analysis app to trigger model download
        logger.info(f"Downloading {ARCFACE_MODEL_NAME} model if not cached...")
        temp_app = insightface.app.FaceAnalysis(
            name=ARCFACE_MODEL_NAME,
            providers=['CPUExecutionProvider']  # Use CPU for model download
        )
        
        # This will download the model if not already cached
        temp_app.prepare(ctx_id=-1, det_size=(640, 640))
        
        logger.info(f"Model {ARCFACE_MODEL_NAME} is ready")
        return True
        
    except Exception as e:
        logger.error(f"Failed to download models: {str(e)}")
        return False

def get_face_processor():
    """Get or create face processor instance."""
    global face_processor
    if face_processor is None:
        # Download models first if needed
        if not download_models_if_needed():
            logger.error("Failed to download required models")
            sys.exit(1)
        
        face_processor = FaceProcessor()
    return face_processor

@app.route('/health', methods=['GET'])
def health_check():
    """Health check endpoint with GPU status."""
    try:
        processor = get_face_processor()
        model_info = processor.get_model_info()
        
        return jsonify({
            'status': 'healthy', 
            'service': 'face-recognition',
            'gpu_acceleration': model_info['using_gpu'],
            'device': model_info['device_info'],
            'model_loaded': model_info['model_loaded']
        })
    except Exception as e:
        return jsonify({
            'status': 'unhealthy',
            'error': str(e),
            'service': 'face-recognition'
        }), 500

@app.route('/status', methods=['GET'])
def get_status():
    """Get detailed system status including GPU information."""
    try:
        processor = get_face_processor()
        model_info = processor.get_model_info()
        
        return jsonify({
            'success': True,
            'model_info': model_info,
            'performance_stats': processor.get_performance_stats()
        })
    except Exception as e:
        logger.error(f"Error getting status: {str(e)}")
        return jsonify({'error': str(e)}), 500

@app.route('/process-photo', methods=['POST'])
def process_photo():
    """Process a photo and extract face embeddings with resource management."""
    import gc
    import threading
    
    # Limit concurrent processing to prevent memory overload
    processing_lock = threading.Semaphore(MAX_WORKERS)
    
    try:
        with processing_lock:
            data = request.json
            # Support both 'file_reference' (new) and 'photoPath' (legacy) parameters
            photo_path = data.get('file_reference') or data.get('photoPath')
            
            if not photo_path:
                return jsonify({'error': 'file_reference or photoPath is required'}), 400
            
            logger.info(f"Processing photo: {photo_path}")
            
            # Get face processor
            processor = get_face_processor()
            
            # Track memory before processing
            start_time = time.time()
            
            # Handle different types of photo references
            faces = None
            
            if photo_path.startswith('http') and 'cloudinary.com' in photo_path:
                # Cloudinary URL - download the image
                logger.info(f"Processing Cloudinary URL: {photo_path}")
                try:
                    response = requests.get(photo_path, timeout=30)
                    response.raise_for_status()
                    
                    # Convert the image data to numpy array
                    image_data = np.frombuffer(response.content, np.uint8)
                    image = cv2.imdecode(image_data, cv2.IMREAD_COLOR)
                    if image is None:
                        return jsonify({'error': 'Could not decode Cloudinary image'}), 400
                    
                    # Convert BGR to RGB for face processing
                    image = cv2.cvtColor(image, cv2.COLOR_BGR2RGB)
                    
                    # Process the image directly
                    faces = processor.detect_faces(image)
                    
                    # Clean up image data
                    del image, image_data
                    
                except requests.RequestException as e:
                    logger.error(f"Error downloading image from Cloudinary: {str(e)}")
                    return jsonify({'error': f'Could not download Cloudinary image: {str(e)}'}), 500
                except Exception as e:
                    logger.error(f"Error processing Cloudinary image: {str(e)}")
                    return jsonify({'error': f'Could not process Cloudinary image: {str(e)}'}), 500
                    
            elif len(photo_path) == 24 and all(c in '0123456789abcdef' for c in photo_path.lower()):
                # This is a GridFS ID, download the image from the main server
                logger.info(f"Processing GridFS ID: {photo_path}")
                try:
                    image_url = f"http://localhost:5000/api/images/{photo_path}"
                    response = requests.get(image_url, timeout=30)
                    response.raise_for_status()
                    
                    # Convert the image data to numpy array
                    image_data = np.frombuffer(response.content, np.uint8)
                    image = cv2.imdecode(image_data, cv2.IMREAD_COLOR)
                    if image is None:
                        return jsonify({'error': 'Could not decode GridFS image'}), 400
                    
                    # Convert BGR to RGB for face processing
                    image = cv2.cvtColor(image, cv2.COLOR_BGR2RGB)
                    
                    # Process the image directly
                    faces = processor.detect_faces(image)
                    
                    # Clean up image data
                    del image, image_data
                    
                except requests.RequestException as e:
                    logger.error(f"Error downloading image from GridFS: {str(e)}")
                    return jsonify({'error': f'Could not download GridFS image: {str(e)}'}), 500
                except Exception as e:
                    logger.error(f"Error processing GridFS image: {str(e)}")
                    return jsonify({'error': f'Could not process GridFS image: {str(e)}'}), 500
            else:
                # This is a local file path, process normally
                logger.info(f"Processing local file: {photo_path}")
                faces = processor.process_image_file(photo_path)
            
            # Force garbage collection after processing
            gc.collect()
            
            processing_time = time.time() - start_time
            logger.info(f"Processed photo {photo_path} in {processing_time:.2f}s, found {len(faces)} faces")
            
            return jsonify({'faces': faces or []})
            
    except Exception as e:
        logger.error(f"Error processing photo: {str(e)}")
        return jsonify({'error': str(e)}), 500
    finally:
        # Force garbage collection on error too
        gc.collect()

@app.route('/compare-faces', methods=['POST'])
def compare_faces():
    """Compare a selfie with stored face embeddings."""
    try:
        data = request.json
        selfie_data = data.get('selfieData')  # Base64 encoded image
        embeddings = data.get('embeddings')  # List of stored embeddings to compare against
        
        if not selfie_data or not embeddings:
            return jsonify({'error': 'selfieData and embeddings are required'}), 400
        
        # Decode base64 image
        image_data = base64.b64decode(selfie_data.split(',')[1] if ',' in selfie_data else selfie_data)
        nparr = np.frombuffer(image_data, np.uint8)
        image = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
        image = cv2.cvtColor(image, cv2.COLOR_BGR2RGB)
        
        # Get face processor
        processor = get_face_processor()
        
        # Detect faces in selfie
        faces = processor.detect_faces(image)
        if not faces:
            return jsonify({'error': 'No face detected in selfie'}), 400
        
        # Use the first face (largest)
        selfie_embedding = np.array(faces[0]['embedding'])
        
        # Calculate similarities
        matches = []
        for i, stored in enumerate(embeddings):
            stored_embedding = np.array(stored['embedding'])
            
            # Calculate cosine similarity
            similarity = np.dot(selfie_embedding, stored_embedding) / (
                np.linalg.norm(selfie_embedding) * np.linalg.norm(stored_embedding)
            )
            
            matches.append({
                'photoId': stored['photoId'],
                'similarity': float(similarity)
            })
        
        # Sort by similarity
        matches.sort(key=lambda x: x['similarity'], reverse=True)
        
        return jsonify({
            'success': True,
            'matches': matches
        })
        
    except Exception as e:
        logger.error(f"Error comparing faces: {str(e)}")
        return jsonify({'error': str(e)}), 500

if __name__ == '__main__':
    # Run on a different port to avoid conflict with main app
    app.run(host='0.0.0.0', port=5001, debug=True)