CREATE UNIQUE INDEX items_name_unique
ON items(normalize_item_name(name));
