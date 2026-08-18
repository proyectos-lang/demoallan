-- ===========================================================================
-- Cierre del EXECUTE implícito a PUBLIC.
--
-- PostgreSQL concede EXECUTE a PUBLIC en TODA función recién creada. Como
-- `anon` y `authenticated` son miembros de PUBLIC, el
--
--     revoke execute on function allan.fn_auditar(...) from authenticated;
--
-- de 0005 no servía de nada: la función seguía siendo llamable, porque el
-- permiso no venía del rol sino de PUBLIC. Verificado con una sesión de rol
-- vendedor, que consiguió insertar una fila de auditoría inventada.
--
-- La corrección es quitar el permiso de PUBLIC — de todo el esquema, no sólo
-- de fn_auditar — y dejar únicamente las concesiones explícitas de 0003.
-- ===========================================================================

-- 1. Fuera el permiso implícito de todas las funciones existentes.
revoke execute on all functions in schema allan from public;
revoke execute on all routines in schema allan from public;

-- `anon` no debe poder ejecutar nada: su única superficie es la vista pública
-- de resultados, que es una vista, no una función.
revoke execute on all functions in schema allan from anon;
revoke execute on all routines in schema allan from anon;

-- 2. Y de las que se creen en el futuro, para que esto no se repita al añadir
--    una función nueva.
alter default privileges for role postgres in schema allan
  revoke execute on routines from public;

-- 3. La auditoría es append-only y la escriben las demás funciones, que al ser
--    SECURITY DEFINER corren como su dueño y no necesitan este permiso. Ningún
--    cliente debe poder llamarla: sería poder fabricar historia.
revoke execute on function allan.fn_auditar(text, uuid, text, text, text, text)
  from authenticated;

-- 4. Las guardas tampoco tienen por qué ser invocables desde fuera.
revoke execute on function allan.fn_exige(allan.rol_usuario[]) from authenticated;
revoke execute on function allan.fn_es_servicio() from authenticated;
