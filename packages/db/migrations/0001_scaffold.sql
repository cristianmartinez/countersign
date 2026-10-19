-- Infrastructure probe only. Domain tables follow the concurrency proof slice.
CREATE TABLE scaffold_metadata (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  schema_version INTEGER NOT NULL
) STRICT;
INSERT INTO scaffold_metadata (id, schema_version) VALUES (1, 1);
