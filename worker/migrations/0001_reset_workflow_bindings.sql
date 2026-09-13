-- One-time reset requested after introducing explicit script confirmation.
DELETE FROM workflow_bindings;
DELETE FROM sessions WHERE data LIKE '%"workflow"%' OR data LIKE '%"options"%';
