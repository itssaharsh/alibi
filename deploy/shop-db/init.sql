CREATE TABLE products (
  sku         text PRIMARY KEY,
  name        text NOT NULL,
  category    text NOT NULL,
  price_cents integer NOT NULL
);

CREATE TABLE orders (
  id          bigserial PRIMARY KEY,
  user_id     text NOT NULL,
  checkout    text NOT NULL,
  coupon      text,
  total_cents integer NOT NULL,
  items       jsonb NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

INSERT INTO products (sku, name, category, price_cents)
SELECT
  'SKU-' || lpad(n::text, 4, '0'),
  'Product ' || n,
  (ARRAY['books', 'kitchen', 'garden', 'toys', 'sport'])[1 + n % 5],
  500 + (n * 37) % 9500
FROM generate_series(1, 400) AS n;
