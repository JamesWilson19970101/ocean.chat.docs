import React, { useState } from 'react';
import clsx from 'clsx';
import styles from './styles.module.css';

interface Props {
  title: string;
  category: 'NATS' | 'Performance' | 'Safety' | 'Caching' | 'Messaging';
  severity?: 'critical' | 'important' | 'info';
  summary: string;
  children: React.ReactNode;
}

export default function DecisionCard({title, category, severity = 'info', summary, children}: Props): JSX.Element {
  const [isExpanded, setIsExpanded] = useState(severity === 'critical');

  return (
    <div className={clsx('card margin-bottom--lg', styles.decisionCard, styles[severity], isExpanded && styles.isExpanded)}>
      <div 
        className={clsx('card__header', styles.cardHeader)} 
        onClick={() => setIsExpanded(!isExpanded)} 
        role="button"
        aria-expanded={isExpanded}
      >
        <div className={styles.headerLeft}>
          <div className={clsx('badge', styles.categoryBadge, styles[`badge--${category.toLowerCase()}`])}>
            {category}
          </div>
          <h3 className={styles.cardTitle}>{title}</h3>
        </div>
        <div className={styles.headerRight}>
          <span className={clsx(styles.chevron, isExpanded && styles.chevronExpanded)}>
            <svg viewBox="0 0 24 24" width="18" height="18">
              <path fill="currentColor" d="M8.59,16.59L13.17,12L8.59,7.41L10,6L16,12L10,18L8.59,16.59Z"></path>
            </svg>
          </span>
        </div>
      </div>
      
      <div className="card__body">
        <div className={styles.decisionSummary}>
          <span className={styles.decisionLabel}>DECISION:</span> {summary}
        </div>
        
        {isExpanded && (
          <div className={styles.decisionDetails}>
            <div className={styles.divider}></div>
            <div className={styles.content}>
              {children}
            </div>
          </div>
        )}
      </div>

      {!isExpanded && (
        <div className={styles.cardFooter} onClick={() => setIsExpanded(true)}>
          <span className={styles.footerLink}>View Rationale & Trade-offs</span>
        </div>
      )}
    </div>
  );
}
