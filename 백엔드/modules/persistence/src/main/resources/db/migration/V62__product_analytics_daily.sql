CREATE TABLE town_product_analytics_daily (
    metric_date DATE NOT NULL,
    metric_key VARCHAR(40) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    event_count BIGINT UNSIGNED NOT NULL DEFAULT 0,
    updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
    PRIMARY KEY (metric_date, metric_key),
    CONSTRAINT ck_product_analytics_metric CHECK (metric_key IN (
        'space_joined', 'event_participation', 'world_rejection', 'api_server_error'
    )),
    CONSTRAINT ck_product_analytics_count CHECK (event_count >= 0)
);
