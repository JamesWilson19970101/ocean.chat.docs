import React, { useState, useEffect } from "react";
import clsx from "clsx";
import useIsBrowser from "@docusaurus/useIsBrowser";
import Translate, { translate } from "@docusaurus/Translate";
import styles from "./styles.module.css";

export default function ProgressBubble() {
  const isBrowser = useIsBrowser();
  const [isOpen, setIsOpen] = useState(false);
  const [isRendered, setIsRendered] = useState(false);
  const [zoomedImage, setZoomedImage] = useState<string | null>(null);

  // For silky smooth modal mounting/unmounting animation
  useEffect(() => {
    if (isOpen || zoomedImage) {
      if (isOpen && !isRendered) setIsRendered(true);
      // Prevent body scrolling when modal or zoomed image is open
      document.body.style.overflow = "hidden";
    } else {
      document.body.style.overflow = "unset";
      // Wait for exit animation before unmounting
      if (!isOpen && isRendered) {
        const timer = setTimeout(() => setIsRendered(false), 400); // matches CSS transition duration
        return () => clearTimeout(timer);
      }
    }
  }, [isOpen, isRendered, zoomedImage]);

  const toggleModal = () => setIsOpen(!isOpen);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setZoomedImage((currentZoom) => {
          if (currentZoom) return null;
          setIsOpen(false);
          return currentZoom;
        });
      }
    };
    
    if (isOpen || zoomedImage) {
      window.addEventListener("keydown", handleKeyDown);
    }
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, zoomedImage]);

  if (!isBrowser) {
    return null; // SSR safe
  }

  return (
    <>
      <div
        className={styles.bubbleContainer}
        onClick={toggleModal}
        role="button"
        tabIndex={0}
        aria-label={translate({
          id: "progress.ariaLabel",
          message: "View Development Progress",
          description: "Aria label for the progress bubble"
        })}
      >
        <div className={styles.bubble}>
          <div className={styles.progressRing}>
            <svg width="40" height="40" viewBox="0 0 40 40">
              <circle
                cx="20"
                cy="20"
                r="16"
                fill="none"
                strokeWidth="4"
                className={styles.ringBg}
              />
              {/* 85% progress: dasharray=100.53, dashoffset=100.53 * (1 - 0.25) = 75.3975 */}
              <circle
                cx="20"
                cy="20"
                r="16"
                fill="none"
                strokeWidth="4"
                className={styles.ringProgress}
                strokeDasharray="100.53"
                strokeDashoffset="75.3975"
              />
            </svg>
            <span className={styles.percentage}>25%</span>
          </div>
          <span className={styles.bubbleText}>
            <Translate id="progress.bubbleText" description="Text inside the progress bubble">
              Progress
            </Translate>
          </span>
        </div>
      </div>

      {isRendered && (
        <div
          className={clsx(styles.modalOverlay, {
            [styles.modalOverlayOpen]: isOpen,
          })}
          onClick={() => setIsOpen(false)}
        >
          <div
            className={clsx(styles.modalContent, {
              [styles.modalContentOpen]: isOpen,
            })}
            onClick={(e) => e.stopPropagation()} // Prevent clicks inside modal from closing it
          >
            <button
              className={styles.closeButton}
              onClick={() => setIsOpen(false)}
              aria-label={translate({
                id: "progress.closeModal",
                message: "Close modal",
                description: "Aria label to close modal"
              })}
            >
              &times;
            </button>
            <h2 className={styles.modalTitle}>
              Ocean.Chat <Translate id="progress.modalTitle" description="Title in the progress modal">Progress</Translate> : 25%
            </h2>
            <div className={styles.imagesGrid}>
              <div 
                className={clsx(styles.imageWrapper, styles.clickableImage)}
                onClick={() => setZoomedImage("img/chat.png")}
              >
                <img src="img/chat.png" alt="Chat UI" />
              </div>
              <div 
                className={clsx(styles.imageWrapper, styles.clickableImage)}
                onClick={() => setZoomedImage("img/login.png")}
              >
                <img src="img/login.png" alt="Login UI" />
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Full-screen image viewer overlay */}
      {zoomedImage && (
        <div 
          className={styles.imageViewerOverlay}
          onClick={() => setZoomedImage(null)}
        >
          <button
            className={styles.imageViewerClose}
            onClick={() => setZoomedImage(null)}
            aria-label={translate({
              id: "progress.closeZoomedImage",
              message: "Close zoomed image",
              description: "Aria label to close zoomed image"
            })}
          >
            &times;
          </button>
          <img 
            src={zoomedImage} 
            alt="Zoomed" 
            className={styles.zoomedImage}
            onClick={(e) => e.stopPropagation()}
          />
        </div>
      )}
    </>
  );
}
