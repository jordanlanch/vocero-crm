import { z } from "zod";
import { apiError, parseBody } from "@/lib/api";
import { requireBotKey, resolveInstanceOrg } from "@/server/bot/auth";
import { getContactStage } from "@/server/contacts";
import { createLeadForContact } from "@/server/inbox/lead-activity";
import { getOrCreateContactByIdentity, parseIdentity } from "@/server/inbox/identity";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  /**
   * EXIGE código de país, en dígitos, por el mismo motivo que en la captura
   * manual (`POST /api/contacts`): un número local jamás casaría con el `from`
   * que manda Meta, y el dueño acabaría con dos fichas de la misma persona.
   *
   * Solo dígitos además cierra el espacio de identidades por la puerta de
   * entrada: aquí solo se registra una identidad de WhatsApp derivada de un
   * teléfono, nunca una `bsuid:`, `ig:`, `fb:` o `tt:` que traiga el cuerpo.
   */
  phone: z
    .string()
    .trim()
    .regex(/^\d{7,15}$/, "Teléfono en dígitos, con código de país (ej. 5215512345678)"),
  name: z.string().trim().min(1).max(120),
  /** Etapa inicial del lead; si no viene, la primera abierta del tablero. */
  stageId: z.string().min(1).optional(),
});

/**
 * Alta de un prospecto que NUNCA ha escrito por WhatsApp.
 *
 * Es la otra mitad del intake. El CRM representa a cada persona por su
 * identidad de WhatsApp, y hasta ahora la única forma de crear una era la
 * pantalla de Contactos, con sesión de navegador: un backend externo que
 * captura un lead en la web abierta no tenía puerta y tenía que replayear la
 * cookie de una persona. Esta es la misma operación para una máquina, en la
 * superficie que ya está hecha para máquinas (`BOT_API_KEY`, sin token de Meta
 * de por medio).
 *
 * Idempotente por teléfono: repetir el alta devuelve lo que ya había en vez de
 * duplicar, porque quien llama es una máquina que reintenta. Por eso el código
 * dice qué pasó y no finge un conflicto — `201` creó esta llamada, `200` ya
 * estaba — y por eso la reconciliación la pone `getOrCreateContactByIdentity`
 * y no un segundo upsert: si el prospecto resulta ser alguien que ya escribió,
 * acaba en el MISMO contacto con su historial, no en una ficha aparte.
 */
export async function POST(req: Request) {
  const denied = requireBotKey(req);
  if (denied) return denied;

  const organizationId = await resolveInstanceOrg();
  if (!organizationId) {
    return apiError(409, "no_org", "La instancia aún no tiene organización");
  }

  const body = await parseBody(req, bodySchema);
  if (!body.ok) return body.response;

  /**
   * La identidad se DERIVA del teléfono y solo del teléfono. Se lee con
   * `parseIdentity` —la misma puerta con que el cerebro lee una identidad— en
   * vez de armar a mano el resolved, para que el 521→52 siga siendo el de la
   * ingesta y no una normalización propia que se quede vieja.
   *
   * Con el esquema de arriba esto no falla, y por eso es una guarda y no una
   * validación: si alguien afloja el regex, un `bsuid:` o un `ig:` en el cuerpo
   * tiene que quedarse fuera del espacio de reconciliación de la ingesta.
   */
  const resolved = parseIdentity(body.data.phone);
  if (!resolved) {
    return apiError(
      422,
      "invalid_phone",
      "Aquí solo se da de alta un teléfono de WhatsApp; una identidad de otro tipo no se acepta"
    );
  }

  const { contact, isNew } = await getOrCreateContactByIdentity(organizationId, {
    ...resolved,
    /**
     * El nombre del intake entra como el del perfil de la identidad. En un
     * contacto NUEVO es el nombre con el que queda, y en uno que ya existía
     * manda la regla de la ingesta: solo se actualiza si su nombre venía de un
     * perfil de WhatsApp, nunca si una persona lo escribió a mano.
     */
    profileName: body.data.name,
  });

  /**
   * Y su lead: un contacto sin lead es un nombre archivado, no algo en el
   * embudo, que es donde se trabaja. `createLeadForContact` es la única puerta
   * que lo crea (la posición, el `onConflictDoNothing` sobre el contacto y el
   * evento de nacimiento viven ahí), y no necesita `actorUserId`: quien da de
   * alta es el cerebro, no una persona, y la bitácora lo registra como tal.
   *
   * Es idempotente (un lead por contacto), así que también se puede llamar en
   * el reintento: devuelve `null` si el lead ya estaba.
   */
  const nuevo = await createLeadForContact({
    organizationId,
    contactId: contact.id,
    stageId: body.data.stageId,
    source: "bot",
  });

  /**
   * `null` son DOS cosas distintas y hay que separarlas: que el lead ya
   * existiera (el alta está hecha: se devuelve el de antes) o que el tablero no
   * tenga etapas abiertas donde colocar al prospecto. Se pregunta a la base en
   * vez de asumir la primera, que es la que devuelve el alta aunque el lead no.
   */
  const lead =
    nuevo ?? (await getContactStage(organizationId, contact.id))?.lead ?? null;
  if (!lead) {
    // El contacto sí queda dado de alta: se reintenta con el mismo teléfono
    // cuando el dueño arme el tablero, y el reintento lo encuentra y solo
    // tiene que culminarlo.
    return apiError(
      422,
      "no_stage",
      "El tablero no tiene etapas abiertas donde colocar al prospecto"
    );
  }

  return Response.json(
    {
      /** `true` = esta llamada creó el contacto. `false` = ya estaba. */
      created: isNew,
      contact: {
        id: contact.id,
        name: contact.name,
        /**
         * La llave estable del contacto (alias neutro de `wa_identity`): es la
         * que se le pasa después a `GET /api/bot/context?identity=`.
         */
        identity: contact.waIdentity,
        phone: contact.phone,
      },
      lead: { id: lead.id, stageId: lead.stageId },
    },
    { status: isNew ? 201 : 200 }
  );
}