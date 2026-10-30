// Adaptación del chat interno de ONG: privados/grupos, membresía, texto/fotos,
// lectura por miembro y las mismas reglas de edición, borrado y reacciones.
// PostgreSQL + JWT de Bandidos reemplazan perfiles y Realtime de Supabase.
import { z } from 'zod';
import { transaction } from './traslados.js';
import { fail, parse, route } from './employeePortal.js';
import { textoDeMensaje, nombreDeGrupo, puedeBorrarMensaje, puedeEditarMensaje, EMOJIS_REACCION } from './chatRules.js';

const uuid=z.string().uuid();
const seq=z.string().regex(/^\d{1,18}$/);
const photoSchema=z.object({data:z.string().max(1400000),type:z.enum(['image/jpeg','image/png','image/webp'])}).strict();
const availableUsers=`SELECT u.id,COALESCE(e.name,u.email) AS name,u.role
  FROM users u LEFT JOIN employees e ON e.tenant_id=u.tenant_id AND e.id=COALESCE(u.employee_id,u.chofer_id)
  WHERE u.tenant_id=$1 AND u.role<>'super_admin'
    AND (COALESCE(u.employee_id,u.chofer_id) IS NULL OR e.status='active')`;

function photoData(photo) {
  if(!photo) return null;
  if(!/^[A-Za-z0-9+/]+={0,2}$/.test(photo.data)) fail(400,'La foto no es válida.');
  const buffer=Buffer.from(photo.data,'base64');
  if(buffer.length===0 || buffer.length>1024*1024 || buffer.toString('base64')!==photo.data) fail(400,'La foto debe pesar hasta 1 MB.');
  const hex=buffer.subarray(0,12).toString('hex');
  if((photo.type==='image/jpeg' && !hex.startsWith('ffd8ff')) ||
     (photo.type==='image/png' && !hex.startsWith('89504e470d0a1a0a')) ||
     (photo.type==='image/webp' && !(hex.startsWith('52494646') && hex.slice(16)==='57454250')))
    fail(400,'Usá una imagen JPEG, PNG o WebP.');
  return photo.data;
}

async function member(db,tenant,id,user,{lock=false}={}) {
  if(lock) await db.query('SELECT id FROM team_chats WHERE tenant_id=$1 AND id=$2 FOR UPDATE',[tenant,id]);
  const r=(await db.query(`SELECT m.*,c.kind,c.name FROM team_chat_members m JOIN team_chats c ON c.tenant_id=m.tenant_id AND c.id=m.chat_id
    WHERE m.tenant_id=$1 AND m.chat_id=$2 AND m.user_id=$3`,[tenant,id,user])).rows[0];
  if(!r) fail(404,'Conversación no encontrada.');
  return r;
}

const messageColumns=`m.id,m.seq::text,m.author_id,m.text,m.created_at,m.edited_at,m.deleted_at,
  m.photo_data IS NOT NULL AND m.created_at>now()-interval '180 days' AS has_photo,
  COALESCE(e.name,u.email,'Usuario eliminado') AS author_name`;
const authorJoin=`LEFT JOIN users u ON u.id=m.author_id AND u.tenant_id=m.tenant_id
  LEFT JOIN employees e ON e.id=COALESCE(u.employee_id,u.chofer_id) AND e.tenant_id=m.tenant_id`;

export function registerChatRoutes(app,pool,{sendPushToUsers=async()=>{}}={}) {
  app.get('/v2/chat/people',route(async(req,res)=>{
    res.json((await pool.query(`${availableUsers} AND u.id<>$2 ORDER BY name,u.id`,[req.tenantId,req.user.sub])).rows);
  }));
  app.get('/v2/chat',route(async(req,res)=>{
    const r=await pool.query(`SELECT c.id,c.kind,
      CASE WHEN c.kind='grupo' THEN c.name ELSE COALESCE((SELECT COALESCE(e.name,u.email)
        FROM team_chat_members other JOIN users u ON u.id=other.user_id AND u.tenant_id=other.tenant_id
        LEFT JOIN employees e ON e.id=COALESCE(u.employee_id,u.chofer_id) AND e.tenant_id=u.tenant_id
        WHERE other.chat_id=c.id AND other.user_id<>$2 LIMIT 1),'Usuario eliminado') END AS name,
      me.is_admin,me.muted,me.favorite,
      (SELECT count(*)::int FROM team_chat_messages m WHERE m.chat_id=c.id AND m.tenant_id=$1
        AND m.seq>GREATEST(me.read_seq,me.joined_after) AND m.author_id<>$2 AND m.deleted_at IS NULL) AS unread,
      last.seq::text AS last_seq,last.text AS last_text,last.author_id AS last_author_id,last.deleted_at AS last_deleted_at,
      last.photo_data IS NOT NULL AS last_has_photo,COALESCE(last.created_at,c.created_at) AS updated_at
      FROM team_chats c JOIN team_chat_members me ON me.chat_id=c.id AND me.tenant_id=c.tenant_id AND me.user_id=$2
      LEFT JOIN LATERAL (SELECT seq,text,author_id,deleted_at,photo_data,created_at FROM team_chat_messages m
        WHERE m.tenant_id=c.tenant_id AND m.chat_id=c.id AND m.seq>me.joined_after ORDER BY seq DESC LIMIT 1) last ON true
      WHERE c.tenant_id=$1 ORDER BY me.favorite DESC,COALESCE(last.created_at,c.created_at) DESC,c.id`,[req.tenantId,req.user.sub]);
    res.json(r.rows);
  }));
  app.post('/v2/chat',route(async(req,res)=>{
    const data=parse(z.object({id:uuid,kind:z.enum(['directa','grupo']),name:z.string().max(60).optional(),members:z.array(uuid).min(1).max(49)}).strict(),req.body);
    const ids=[...new Set([req.user.sub,...data.members])].sort();
    if(ids.length<2 || (data.kind==='directa' && ids.length!==2)) fail(400,'Elegí a las personas de la conversación.');
    const name=data.kind==='grupo' ? nombreDeGrupo(data.name) : null;
    const directKey=data.kind==='directa' ? ids.join(':') : null;
    const result=await transaction(pool,async db=>{
      const allowed=(await db.query(availableUsers,[req.tenantId])).rows.map(u=>u.id);
      if(ids.some(id=>!allowed.includes(id))) fail(400,'Solo podés conversar con usuarios activos de tu local.');
      // El cliente conserva id en los reintentos; la pareja privada también
      // es única aunque ambas personas abran el chat al mismo tiempo.
      const saved=(await db.query(`INSERT INTO team_chats(id,tenant_id,kind,name,direct_key) VALUES($1,$2,$3,$4,$5)
        ON CONFLICT DO NOTHING RETURNING id`,[data.id,req.tenantId,data.kind,name,directKey])).rows[0];
      if(!saved){
        const old=(await db.query(`SELECT id,kind,name FROM team_chats WHERE tenant_id=$1 AND
          (id=$2 OR (direct_key=$3 AND $3 IS NOT NULL)) ORDER BY id LIMIT 1`,[req.tenantId,data.id,directKey])).rows[0];
        if(!old || old.kind!==data.kind || (data.kind==='grupo' && old.name!==name)) fail(409,'Ese identificador ya está en uso.');
        await member(db,req.tenantId,old.id,req.user.sub);
        const previous=(await db.query('SELECT user_id FROM team_chat_members WHERE chat_id=$1',[old.id])).rows.map(m=>m.user_id).sort();
        if(previous.join(':')!==ids.join(':')) fail(409,'Los participantes cambiaron. Volvé a abrir la conversación.');
        return old;
      }
      for(const id of ids) await db.query('INSERT INTO team_chat_members(tenant_id,chat_id,user_id,is_admin) VALUES($1,$2,$3,$4)',[req.tenantId,saved.id,id,id===req.user.sub]);
      return saved;
    });
    res.status(201).json(result);
  }));
  app.get('/v2/chat/:id',route(async(req,res)=>{
    const id=parse(uuid,req.params.id);
    const me=await member(pool,req.tenantId,id,req.user.sub);
    const members=(await pool.query(`SELECT m.user_id,m.is_admin,m.read_seq::text,COALESCE(e.name,u.email) AS name
      FROM team_chat_members m JOIN users u ON u.id=m.user_id AND u.tenant_id=m.tenant_id
      LEFT JOIN employees e ON e.id=COALESCE(u.employee_id,u.chofer_id) AND e.tenant_id=u.tenant_id
      WHERE m.tenant_id=$1 AND m.chat_id=$2 ORDER BY name,m.user_id`,[req.tenantId,id])).rows;
    res.json({...me,read_seq:String(me.read_seq),joined_after:String(me.joined_after),members});
  }));
  app.patch('/v2/chat/:id/preferences',route(async(req,res)=>{
    const id=parse(uuid,req.params.id);
    const data=parse(z.object({muted:z.boolean().optional(),favorite:z.boolean().optional()}).strict().refine(v=>Object.keys(v).length>0),req.body);
    await member(pool,req.tenantId,id,req.user.sub);
    await pool.query('UPDATE team_chat_members SET muted=COALESCE($4,muted),favorite=COALESCE($5,favorite) WHERE tenant_id=$1 AND chat_id=$2 AND user_id=$3',[req.tenantId,id,req.user.sub,data.muted??null,data.favorite??null]);
    res.json({ok:true});
  }));
  app.put('/v2/chat/:id/members',route(async(req,res)=>{
    const id=parse(uuid,req.params.id);
    const {members}=parse(z.object({members:z.array(uuid).min(2).max(50)}).strict(),req.body);
    await transaction(pool,async db=>{
      const me=await member(db,req.tenantId,id,req.user.sub,{lock:true});
      if(me.kind!=='grupo' || !me.is_admin) fail(403,'Solo quien administra el grupo puede cambiar los participantes.');
      if(!members.includes(req.user.sub)) fail(400,'Conservá tu cuenta como administradora del grupo.');
      const allowed=(await db.query(availableUsers,[req.tenantId])).rows.map(u=>u.id);
      if(members.some(id=>!allowed.includes(id))) fail(400,'Elegí usuarios activos del mismo local.');
      const last=(await db.query('SELECT COALESCE(max(seq),0)::text AS seq FROM team_chat_messages WHERE tenant_id=$1 AND chat_id=$2',[req.tenantId,id])).rows[0].seq;
      await db.query('DELETE FROM team_chat_members WHERE tenant_id=$1 AND chat_id=$2 AND NOT (user_id=ANY($3::uuid[]))',[req.tenantId,id,members]);
      for(const userId of new Set(members)) await db.query(`INSERT INTO team_chat_members(tenant_id,chat_id,user_id,joined_after,read_seq)
        VALUES($1,$2,$3,$4,$4) ON CONFLICT DO NOTHING`,[req.tenantId,id,userId,last]);
    });
    res.json({ok:true});
  }));
  app.get('/v2/chat/:id/messages',route(async(req,res)=>{
    const id=parse(uuid,req.params.id);
    const q=parse(z.object({before:seq.optional(),search:z.string().trim().min(1).max(100).optional()}).strict(),req.query);
    const me=await member(pool,req.tenantId,id,req.user.sub);
    const rows=(await pool.query(`SELECT ${messageColumns} FROM team_chat_messages m ${authorJoin}
      WHERE m.tenant_id=$1 AND m.chat_id=$2 AND m.seq>$3 AND ($4::bigint IS NULL OR m.seq<$4)
        AND ($5::text IS NULL OR (m.deleted_at IS NULL AND strpos(lower(m.text),lower($5))>0))
      ORDER BY m.seq DESC LIMIT 51`,[req.tenantId,id,me.joined_after,q.before??null,q.search??null])).rows;
    const hasMore=rows.length>50, messages=rows.slice(0,50).reverse();
    const reactions=messages.length ? (await pool.query(`SELECT r.message_id,r.emoji,array_agg(r.user_id) AS users FROM team_chat_reactions r
      WHERE r.message_id=ANY($1::uuid[]) GROUP BY r.message_id,r.emoji`,[messages.map(m=>m.id)])).rows : [];
    res.json({messages:messages.map(m=>({...m,reactions:reactions.filter(r=>r.message_id===m.id)})),has_more:hasMore,before:hasMore ? messages[0].seq : null});
  }));
  app.post('/v2/chat/:id/messages',route(async(req,res)=>{
    const id=parse(uuid,req.params.id);
    const data=parse(z.object({id:uuid,text:z.string().max(4000).nullable().optional(),photo:photoSchema.optional()}).strict(),req.body);
    const text=textoDeMensaje(data.text), photo=photoData(data.photo);
    if(!text && !photo) fail(400,'Escribí un mensaje o adjuntá una foto.');
    let recipients=[], inserted=false;
    const saved=await transaction(pool,async db=>{
      await member(db,req.tenantId,id,req.user.sub,{lock:true});
      const old=(await db.query('SELECT id,seq::text,tenant_id,chat_id,author_id,text,photo_data,photo_type,deleted_at FROM team_chat_messages WHERE id=$1',[data.id])).rows[0];
      if(old){
        if(old.tenant_id!==req.tenantId || old.chat_id!==id || old.author_id!==req.user.sub || old.deleted_at || old.text!==text || old.photo_data!==photo || old.photo_type!==(data.photo?.type??null)) fail(409,'Ese identificador ya corresponde a otro mensaje.');
        return {id:old.id,seq:old.seq};
      }
      // Serializa también entre distintas conversaciones del mismo usuario.
      await db.query('SELECT id FROM users WHERE id=$1 FOR UPDATE',[req.user.sub]);
      const count=Number((await db.query("SELECT count(*) FROM team_chat_messages WHERE tenant_id=$1 AND author_id=$2 AND created_at>now()-interval '1 minute'",[req.tenantId,req.user.sub])).rows[0].count);
      if(count>=30) fail(429,'Esperá un momento antes de mandar más mensajes.');
      const result=(await db.query(`INSERT INTO team_chat_messages(id,tenant_id,chat_id,author_id,text,photo_data,photo_type)
        VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id,seq::text`,[data.id,req.tenantId,id,req.user.sub,text,photo,data.photo?.type??null])).rows[0];
      recipients=(await db.query('SELECT user_id FROM team_chat_members WHERE tenant_id=$1 AND chat_id=$2 AND user_id<>$3 AND NOT muted',[req.tenantId,id,req.user.sub])).rows.map(m=>m.user_id);
      inserted=true;
      return result;
    });
    res.status(201).json(saved);
    // Los avisos de chat solo van a sus miembros, nunca al local completo.
    if(inserted) void sendPushToUsers(req.tenantId,recipients,{title:'Nuevo mensaje en Bandidos',body:'Tenés un mensaje del equipo.',url:'/chat'}).catch(e=>console.error('[chat push]',e.message));
  }));
  app.post('/v2/chat/:id/read',route(async(req,res)=>{
    const id=parse(uuid,req.params.id),{through}=parse(z.object({through:seq}).strict(),req.body);
    const me=await member(pool,req.tenantId,id,req.user.sub);
    const visible=(await pool.query('SELECT seq FROM team_chat_messages WHERE tenant_id=$1 AND chat_id=$2 AND seq=$3 AND seq>$4',[req.tenantId,id,through,me.joined_after])).rows.length;
    if(!visible) fail(400,'La lectura debe corresponder a un mensaje visible.');
    await pool.query('UPDATE team_chat_members SET read_seq=GREATEST(read_seq,$4::bigint) WHERE tenant_id=$1 AND chat_id=$2 AND user_id=$3',[req.tenantId,id,req.user.sub,through]);
    res.json({ok:true});
  }));
  app.get('/v2/chat/:id/messages/:messageId/photo',route(async(req,res)=>{
    const id=parse(uuid,req.params.id),messageId=parse(uuid,req.params.messageId);
    const me=await member(pool,req.tenantId,id,req.user.sub);
    const photo=(await pool.query(`SELECT photo_data,photo_type FROM team_chat_messages
      WHERE tenant_id=$1 AND chat_id=$2 AND id=$3 AND seq>$4 AND deleted_at IS NULL
        AND created_at>now()-interval '180 days' AND photo_data IS NOT NULL`,[req.tenantId,id,messageId,me.joined_after])).rows[0];
    if(!photo) fail(404,'Foto no disponible.');
    res.set('Cache-Control','no-store').json({url:`data:${photo.photo_type};base64,${photo.photo_data}`});
  }));
  for(const method of ['patch','delete']) app[method]('/v2/chat/:id/messages/:messageId',route(async(req,res)=>{
    const id=parse(uuid,req.params.id),messageId=parse(uuid,req.params.messageId);
    await transaction(pool,async db=>{
      const me=await member(db,req.tenantId,id,req.user.sub,{lock:true});
      const message=(await db.query('SELECT *,author_id AS autor_id,created_at::text,deleted_at AS eliminado_at FROM team_chat_messages WHERE tenant_id=$1 AND chat_id=$2 AND id=$3 AND seq>$4 FOR UPDATE',[req.tenantId,id,messageId,me.joined_after])).rows[0];
      if(!message) fail(404,'Mensaje no encontrado.');
      if(method==='patch'){
        const {text}=parse(z.object({text:z.string().max(4000)}).strict(),req.body);
        const clean=textoDeMensaje(text);
        if(!clean) fail(400,'El texto no puede quedar vacío.');
        if(!puedeEditarMensaje(message,req.user.sub)) fail(403,'Solo podés editar tus mensajes durante 15 minutos.');
        await db.query('UPDATE team_chat_messages SET text=$2,edited_at=now() WHERE id=$1',[messageId,clean]);
      }else{
        if(!puedeBorrarMensaje(message,req.user.sub,{esDireccion:req.user.role==='admin'})) fail(403,'No podés borrar ese mensaje.');
        await db.query('UPDATE team_chat_messages SET text=NULL,photo_data=NULL,photo_type=NULL,deleted_at=now() WHERE id=$1',[messageId]);
        await db.query('DELETE FROM team_chat_reactions WHERE message_id=$1',[messageId]);
      }
    });
    res.json({ok:true});
  }));
  app.put('/v2/chat/:id/messages/:messageId/reaction',route(async(req,res)=>{
    const id=parse(uuid,req.params.id),messageId=parse(uuid,req.params.messageId);
    const {emoji}=parse(z.object({emoji:z.enum(EMOJIS_REACCION).nullable()}).strict(),req.body);
    await transaction(pool,async db=>{
      const me=await member(db,req.tenantId,id,req.user.sub,{lock:true});
      const found=(await db.query('SELECT id FROM team_chat_messages WHERE tenant_id=$1 AND chat_id=$2 AND id=$3 AND seq>$4 AND deleted_at IS NULL',[req.tenantId,id,messageId,me.joined_after])).rows.length;
      if(!found) fail(404,'Mensaje no encontrado.');
      if(emoji===null) await db.query('DELETE FROM team_chat_reactions WHERE message_id=$1 AND user_id=$2',[messageId,req.user.sub]);
      else await db.query('INSERT INTO team_chat_reactions(message_id,user_id,emoji) VALUES($1,$2,$3) ON CONFLICT(message_id,user_id) DO UPDATE SET emoji=$3',[messageId,req.user.sub,emoji]);
    });
    res.json({ok:true});
  }));
}
