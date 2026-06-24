-- Migración 015: Fusionar el método de pago duplicado 'Cash' en 'Efectivo'

-- 1. Actualizar las referencias de 'Cash' (id: '2d4ce082-17c6-40dc-9d5e-d6b3b60cc411') a 'Efectivo' (id: '9c39349f-8530-4ffc-afbc-495878404a8c')
UPDATE services 
  SET payment_method_id = '9c39349f-8530-4ffc-afbc-495878404a8c' 
  WHERE payment_method_id = '2d4ce082-17c6-40dc-9d5e-d6b3b60cc411';

UPDATE agenda_turnos 
  SET payment_method_id = '9c39349f-8530-4ffc-afbc-495878404a8c' 
  WHERE payment_method_id = '2d4ce082-17c6-40dc-9d5e-d6b3b60cc411';

UPDATE petshop_sales 
  SET payment_method_id = '9c39349f-8530-4ffc-afbc-495878404a8c' 
  WHERE payment_method_id = '2d4ce082-17c6-40dc-9d5e-d6b3b60cc411';

UPDATE daily_expenses 
  SET payment_method_id = '9c39349f-8530-4ffc-afbc-495878404a8c' 
  WHERE payment_method_id = '2d4ce082-17c6-40dc-9d5e-d6b3b60cc411';

UPDATE fixed_expenses 
  SET payment_method_id = '9c39349f-8530-4ffc-afbc-495878404a8c' 
  WHERE payment_method_id = '2d4ce082-17c6-40dc-9d5e-d6b3b60cc411';

UPDATE daily_incomes 
  SET payment_method_id = '9c39349f-8530-4ffc-afbc-495878404a8c' 
  WHERE payment_method_id = '2d4ce082-17c6-40dc-9d5e-d6b3b60cc411';

-- 2. Eliminar el método de pago 'Cash' duplicado
DELETE FROM payment_methods 
  WHERE id = '2d4ce082-17c6-40dc-9d5e-d6b3b60cc411';
