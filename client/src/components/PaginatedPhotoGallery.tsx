import React, { useState, useEffect, useMemo } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Eye, Download, Heart, HeartOff, Loader2, ChevronLeft, ChevronRight, ImageIcon } from 'lucide-react';
import ProgressiveImage from './ProgressiveImage';
import { Photo } from '@shared/types';
import { useAuth } from '@/contexts/AuthContext';

interface PaginatedPhotoGalleryProps {
  photos: Photo[];
  loading?: boolean;
  onPhotoClick?: (photo: Photo) => void;
  className?: string;
  showSaveToProfile?: boolean;
  savedPhotoIds?: string[];
  onSavePhoto?: (photoId: string) => void;
  onRemovePhoto?: (photoId: string) => void;
  savingPhotoIds?: string[];
  photosPerPage?: number;
}

const PaginatedPhotoGallery: React.FC<PaginatedPhotoGalleryProps> = ({
  photos,
  loading = false,
  onPhotoClick,
  className = '',
  showSaveToProfile = false,
  savedPhotoIds = [],
  onSavePhoto,
  onRemovePhoto,
  savingPhotoIds = [],
  photosPerPage = 50
}) => {
  const [currentPage, setCurrentPage] = useState(1);
  const [loadedPhotos, setLoadedPhotos] = useState<Set<string>>(new Set());
  const [errorPhotos, setErrorPhotos] = useState<Set<string>>(new Set());
  const { currentUser } = useAuth();

  // Calculate pagination
  const totalPages = Math.ceil(photos.length / photosPerPage);
  const startIndex = (currentPage - 1) * photosPerPage;
  const endIndex = startIndex + photosPerPage;
  const currentPhotos = photos.slice(startIndex, endIndex);

  // Reset to first page when photos change
  useEffect(() => {
    setCurrentPage(1);
    setLoadedPhotos(new Set());
    setErrorPhotos(new Set());
  }, [photos]);

  const handlePhotoLoad = (photoId: string) => {
    setLoadedPhotos(prev => new Set(prev).add(photoId));
  };

  const handlePhotoError = (photoId: string) => {
    setErrorPhotos(prev => new Set(prev).add(photoId));
  };

  const handleDownload = async (photo: Photo, e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      const response = await fetch(`${photo.url}?download=true`);
      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = photo.filename || 'photo';
      document.body.appendChild(link);
      link.click();
      window.URL.revokeObjectURL(url);
      document.body.removeChild(link);
    } catch (error) {
      console.error('Error downloading photo:', error);
    }
  };

  const goToPage = (page: number) => {
    if (page >= 1 && page <= totalPages) {
      setCurrentPage(page);
    }
  };

  const goToNextPage = () => {
    if (currentPage < totalPages) {
      setCurrentPage(currentPage + 1);
    }
  };

  const goToPreviousPage = () => {
    if (currentPage > 1) {
      setCurrentPage(currentPage - 1);
    }
  };

  if (loading) {
    return (
      <div className={`${className}`}>
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-4">
          {[...Array(photosPerPage)].map((_, index) => (
            <Card key={index} className="aspect-square overflow-hidden animate-pulse">
              <CardContent className="p-0 h-full bg-gray-200">
                <div className="w-full h-full bg-gradient-to-r from-gray-200 via-gray-300 to-gray-200 animate-pulse" />
              </CardContent>
            </Card>
          ))}
        </div>
      </div>
    );
  }

  if (photos.length === 0) {
    return (
      <div className={`${className} text-center py-12`}>
        <ImageIcon className="h-16 w-16 text-gray-400 mx-auto mb-4" />
        <p className="text-gray-500 text-lg">No photos available</p>
      </div>
    );
  }

  return (
    <div className={`${className}`}>
      {/* Photo Grid */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-4 mb-6">
        {currentPhotos.map((photo) => (
          <PhotoCard
            key={photo.id}
            photo={photo}
            onPhotoClick={onPhotoClick}
            onDownload={handleDownload}
            onLoad={() => handlePhotoLoad(photo.id)}
            onError={() => handlePhotoError(photo.id)}
            loaded={loadedPhotos.has(photo.id)}
            error={errorPhotos.has(photo.id)}
            showSaveToProfile={showSaveToProfile}
            savedPhotoIds={savedPhotoIds}
            onSavePhoto={onSavePhoto}
            onRemovePhoto={onRemovePhoto}
            savingPhotoIds={savingPhotoIds}
            currentUser={currentUser}
          />
        ))}
      </div>

      {/* Pagination Controls */}
      {totalPages > 1 && (
        <div className="flex items-center justify-center gap-2 mt-8">
          {/* Previous Button */}
          <Button
            variant="outline"
            size="sm"
            onClick={goToPreviousPage}
            disabled={currentPage === 1}
            className="flex items-center gap-1"
          >
            <ChevronLeft className="h-4 w-4" />
            Previous
          </Button>

          {/* Page Numbers */}
          <div className="flex items-center gap-1">
            {/* First page */}
            {currentPage > 3 && (
              <>
                <Button
                  variant={1 === currentPage ? "default" : "outline"}
                  size="sm"
                  onClick={() => goToPage(1)}
                  className="w-10 h-10 p-0"
                >
                  1
                </Button>
                {currentPage > 4 && <span className="px-2">...</span>}
              </>
            )}

            {/* Current page and surrounding pages */}
            {Array.from({ length: Math.min(5, totalPages) }, (_, i) => {
              let pageNum;
              if (totalPages <= 5) {
                pageNum = i + 1;
              } else if (currentPage <= 3) {
                pageNum = i + 1;
              } else if (currentPage >= totalPages - 2) {
                pageNum = totalPages - 4 + i;
              } else {
                pageNum = currentPage - 2 + i;
              }

              if (pageNum < 1 || pageNum > totalPages) return null;

              return (
                <Button
                  key={pageNum}
                  variant={pageNum === currentPage ? "default" : "outline"}
                  size="sm"
                  onClick={() => goToPage(pageNum)}
                  className="w-10 h-10 p-0"
                >
                  {pageNum}
                </Button>
              );
            })}

            {/* Last page */}
            {currentPage < totalPages - 2 && (
              <>
                {currentPage < totalPages - 3 && <span className="px-2">...</span>}
                <Button
                  variant={totalPages === currentPage ? "default" : "outline"}
                  size="sm"
                  onClick={() => goToPage(totalPages)}
                  className="w-10 h-10 p-0"
                >
                  {totalPages}
                </Button>
              </>
            )}
          </div>

          {/* Next Button */}
          <Button
            variant="outline"
            size="sm"
            onClick={goToNextPage}
            disabled={currentPage === totalPages}
            className="flex items-center gap-1"
          >
            Next
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
      )}

      {/* Page Info */}
      <div className="text-center text-sm text-gray-500 mt-4">
        Showing {startIndex + 1}-{Math.min(endIndex, photos.length)} of {photos.length} photos
        {totalPages > 1 && ` • Page ${currentPage} of ${totalPages}`}
      </div>
    </div>
  );
};

// Photo Card Component
interface PhotoCardProps {
  photo: Photo;
  onPhotoClick?: (photo: Photo) => void;
  onDownload: (photo: Photo, e: React.MouseEvent) => void;
  onLoad: () => void;
  onError: () => void;
  loaded: boolean;
  error: boolean;
  showSaveToProfile: boolean;
  savedPhotoIds: string[];
  onSavePhoto?: (photoId: string) => void;
  onRemovePhoto?: (photoId: string) => void;
  savingPhotoIds: string[];
  currentUser: any;
}

const PhotoCard: React.FC<PhotoCardProps> = ({
  photo,
  onPhotoClick,
  onDownload,
  onLoad,
  onError,
  loaded,
  error,
  showSaveToProfile,
  savedPhotoIds,
  onSavePhoto,
  onRemovePhoto,
  savingPhotoIds,
  currentUser
}) => {
  const handleSaveToProfile = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (onSavePhoto) {
      onSavePhoto(photo.id);
    }
  };

  const handleRemoveFromProfile = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (onRemovePhoto) {
      onRemovePhoto(photo.id);
    }
  };

  const isPhotoSaved = savedPhotoIds.includes(photo.id);
  const isPhotoSaving = savingPhotoIds.includes(photo.id);
  const canShowSaveButton = showSaveToProfile && currentUser;

  return (
    <Card className="group hover:shadow-xl transition-all duration-300 hover:scale-105 overflow-hidden cursor-pointer">
      <CardContent className="p-0 aspect-square relative">
        {/* Loading skeleton */}
        {!loaded && !error && (
          <div className="absolute inset-0 bg-gradient-to-r from-gray-200 via-gray-300 to-gray-200 animate-pulse">
            <div className="absolute inset-0 bg-gradient-to-r from-transparent via-white to-transparent opacity-40 animate-pulse" 
                 style={{ animationDuration: '2s' }} />
          </div>
        )}
        
        {/* Error state */}
        {error && (
          <div className="absolute inset-0 flex items-center justify-center bg-gray-100">
            <ImageIcon className="h-8 w-8 text-gray-400" />
          </div>
        )}
        
        {/* Progressive Image with optimized loading */}
        <ProgressiveImage
          src={photo.url}
          alt={photo.filename || 'Photo'}
          className="w-full h-full object-cover transition-all duration-300 group-hover:scale-110"
          priority="high"
          aspectRatio={1}
          onLoad={onLoad}
          onError={onError}
          loading="lazy"
        />
        
        {/* Hover overlay */}
        <div 
          className="absolute inset-0 bg-black bg-opacity-0 group-hover:bg-opacity-40 transition-all duration-200 flex items-center justify-center opacity-0 group-hover:opacity-100"
        >
          <div className="flex space-x-2">
            <Button
              variant="secondary"
              size="sm"
              className="bg-white/90 hover:bg-white"
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                console.log('Eye icon clicked for photo:', photo.id);
                // Use setTimeout to ensure the event is processed after the current stack
                setTimeout(() => {
                  onPhotoClick?.(photo);
                }, 0);
              }}
            >
              <Eye className="h-4 w-4" />
            </Button>
            <Button
              variant="secondary"
              size="sm"
              className="bg-white/90 hover:bg-white"
              onClick={(e) => onDownload(photo, e)}
            >
              <Download className="h-4 w-4" />
            </Button>
            {canShowSaveButton && (
              <Button
                variant="secondary"
                size="sm"
                className={`bg-white/90 hover:bg-white ${isPhotoSaved ? 'text-red-500' : 'text-green-500'}`}
                onClick={isPhotoSaved ? handleRemoveFromProfile : handleSaveToProfile}
                disabled={isPhotoSaving}
              >
                {isPhotoSaving ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : isPhotoSaved ? (
                  <HeartOff className="h-4 w-4" />
                ) : (
                  <Heart className="h-4 w-4" />
                )}
              </Button>
            )}
          </div>
        </div>
        
        {/* Loading indicator for individual photos */}
        {!loaded && !error && (
          <div className="absolute bottom-2 right-2 bg-black/50 rounded-full p-1">
            <Loader2 className="h-3 w-3 animate-spin text-white" />
          </div>
        )}
      </CardContent>
    </Card>
  );
};

export default PaginatedPhotoGallery;