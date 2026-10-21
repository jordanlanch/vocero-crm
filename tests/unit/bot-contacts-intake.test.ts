import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetRateLimit } from "@/lib/rate-limit";

/**
 * Alta de un prospecto que NUNCA ha escrito por WhatsApp, desde la API de
 * servicio `/api/bot/*`.
 *
 * Es la otra mitad del intake: hasta ahora el CRM solo daba de alta contactos
 * por sesión de navegador (`POST /api/contacts`), de modo que un backend externo
 * que captura un lead en la web abierta no tenía puerta: o replayeaba la
 * cookie de una persona, o no tenía nada.
 *
 * Lo que estas pruebas fijan:
 * - la superficie está CERRADA sin `BOT_API_KEY` (una ruta sin llave que
 *   responde 201 sería un buzón abierto, no una puerta);
 * - crea contacto Y lead: un contacto sin lead es un nombre archivado, no algo
 *   en el embudo;
 * - es idempotente por teléfono, y el código dice qué pasó: 201 lo creó esta
 *   llamada, 200 ya estaba (una máquina que reintenta no debe leer un conflicto);
 * - la identidad la deriva del TELÉFONO y de nada que venga en el cuerpo: el
 *   espacio de reconciliación de la ingesta no es alcanzable con una identidad
 *   arbitraria que mande el llamador.
 *
 * Los dobles espejan el contrato de las dos puertas reales que la ruta usa:
 * `getOrCreateContactByIdentity` (mismo contacto por la misma identidad) y
 * `createLeadForContact` (`onConflictDoNothing` sobre el contacto: `null` si ya
 * había lead, y `null` también si el tablero no tiene etapas abiertas).
 */

const KEY = "clave-de-servicio-larga-0123456789abcdef";

/** Fila de `contact` en el doble: lo que guarda `getOrCreateContactByIdentity`. */
type Fila = {
  id: string;
  name: string;
  waIdentity: string;
  phone: string | null;
  channel: string;
};
type Lead = { id: string; stageId: string };
/** Lo que la ruta responde; `identity` es el alias neutro de `waIdentity`. */
type Respuesta = {
  created: boolean;
  contact: { id: string; name: string; identity: string; phone: string | null };
  lead: Lead | null;
  error?: { code?: string; message?: string };
};

const estado = vi.hoisted(() => ({
  orgId: "org_1" as string | null,
  contactos: new Map<string, Fila>(),
  leads: new Map<string, { id: string; stageId: string }>(),
  etapas: true,
  seq: 0,
  identidades: [] as string[],
  nombres: [] as (string | null)[],
  pedidosDeLead: [] as { organizationId: string; contactId: string; stageId?: string; source?: string }[],
}));

// `requireBotKey` se queda REAL: que la puerta siga cerrada es justo lo que
// hay que probar, y un doble que devuelve `null` probaría el doble.
vi.mock("@/server/bot/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/bot/auth")>()),
  resolveInstanceOrg: async () => estado.orgId,
}));

vi.mock("@/server/inbox/identity", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/inbox/identity")>();
  return {
    ...actual,
    getOrCreateContactByIdentity: vi.fn(
      async (organizationId: string, resolved: { identity: string; phone: string | null; channel?: string; profileName: string | null }) => {
        estado.identidades.push(resolved.identity);
        estado.nombres.push(resolved.profileName);
        const previo = estado.contactos.get(resolved.identity);
        if (previo) return { contact: previo, isNew: false };
        const contact = {
          id: `ct_${++estado.seq}`,
          name: resolved.profileName?.trim() || resolved.identity,
          waIdentity: resolved.identity,
          phone: resolved.phone,
          channel: resolved.channel ?? "whatsapp",
        };
        estado.contactos.set(resolved.identity, contact);
        return { contact, isNew: true };
      }
    ),
  };
});

vi.mock("@/server/inbox/lead-activity", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/inbox/lead-activity")>();
  return {
    ...actual,
    createLeadForContact: vi.fn(
      async (input: { organizationId: string; contactId: string; stageId?: string; source?: string }) => {
        estado.pedidosDeLead.push(input);
        // El helper real sale antes de insertar si no hay etapa abierta.
        if (!estado.etapas) return null;
        if (estado.leads.has(input.contactId)) return null;
        const lead = { id: `lead_${++estado.seq}`, stageId: input.stageId ?? "ps_1" };
        estado.leads.set(input.contactId, lead);
        return lead;
      }
    ),
  };
});

vi.mock("@/server/contacts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/contacts")>();
  return {
    ...actual,
    getContactStage: vi.fn(async (organizationId: string, contactId: string) => {
      const lead = estado.leads.get(contactId);
      return lead ? { lead, stage: { id: "ps_1", name: "Nuevos" } } : null;
    }),
  };
});

import { POST } from "@/app/api/bot/contacts/route";

function peticion(cuerpo: unknown, key?: string): Promise<Response> {
  return POST(
    new Request("http://localhost/api/bot/contacts", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(key ? { "x-api-key": key } : {}),
      },
      body: typeof cuerpo === "string" ? cuerpo : JSON.stringify(cuerpo),
    })
  );
}

beforeEach(() => {
  vi.stubEnv("BOT_API_KEY", KEY);
  resetRateLimit();
  estado.orgId = "org_1";
  estado.contactos.clear();
  estado.leads.clear();
  estado.etapas = true;
  estado.seq = 0;
  estado.identidades = [];
  estado.nombres = [];
  estado.pedidosDeLead = [];
});
afterEach(() => vi.unstubAllEnvs());

describe("POST /api/bot/contacts — la puerta", () => {
  it("sin llave → 401 y ni una escritura (una fila de más sería un buzón abierto)", async () => {
    const res = await peticion({ phone: "5215550001234", name: "Ana" });
    expect(res.status).toBe(401);
    expect((await res.json()) as Respuesta).toMatchObject({
      error: { code: "unauthorized" },
    });
    expect(estado.contactos.size).toBe(0);
    expect(estado.pedidosDeLead).toHaveLength(0);
  });

  it("llave equivocada → 401 con el MISMO cuerpo que sin llave (no filtra si existe)", async () => {
    const res = await peticion({ phone: "5215550001234", name: "Ana" }, "otra-clave-igual-de-larga-pero-mala!!");
    expect(res.status).toBe(401);
    expect((await res.json()) as Respuesta).toMatchObject({
      error: { code: "unauthorized" },
    });
    expect(estado.contactos.size).toBe(0);
  });

  it("instancia sin organización → 409 no_org (después de autenticar, no antes)", async () => {
    estado.orgId = null;
    const res = await peticion({ phone: "5215550001234", name: "Ana" }, KEY);
    expect(res.status).toBe(409);
    expect((await res.json()) as Respuesta).toMatchObject({ error: { code: "no_org" } });
    expect(estado.contactos.size).toBe(0);
  });
});

describe("POST /api/bot/contacts — qué crea", () => {
  it("llave válida → 201: contacto Y lead, con la identidad del teléfono normalizado", async () => {
    const res = await peticion({ phone: "5215550001234", name: "Ana Pérez" }, KEY);
    expect(res.status).toBe(201);

    const body = (await res.json()) as Respuesta;
    expect(body.created).toBe(true);
    // `identity` es la llave estable del contacto: la que después se le pasa a
    // `GET /api/bot/context?identity=`.
    expect(body.contact.identity).toBe("525550001234");
    expect(body.contact.name).toBe("Ana Pérez");
    expect(body.lead).not.toBeNull();

    // 521 → 52, igual que el `from` del webhook: la identidad la pone el CRM.
    expect(estado.identidades).toEqual(["525550001234"]);
    expect(estado.nombres).toEqual(["Ana Pérez"]);
    // El lead se crea para ESE contacto y en la organización de la instancia.
    expect(estado.pedidosDeLead).toHaveLength(1);
    expect(estado.pedidosDeLead[0]).toMatchObject({
      organizationId: "org_1",
      contactId: body.contact.id,
    });
  });

  it("la etapa que pide el cuerpo se respeta; si no, la primera abierta", async () => {
    const res = await peticion(
      { phone: "525550001234", name: "Ana", stageId: "ps_calidos" },
      KEY
    );
    const body = (await res.json()) as Respuesta;
    expect(res.status).toBe(201);
    expect(estado.pedidosDeLead[0]).toMatchObject({ stageId: "ps_calidos" });
    expect(body.lead?.stageId).toBe("ps_calidos");
  });
});

describe("POST /api/bot/contacts — idempotencia por identidad", () => {
  it("el mismo teléfono dos veces → 200 la segunda, los MISMOS ids y ni una fila de más", async () => {
    const uno = (await (await peticion({ phone: "525550001234", name: "Ana" }, KEY)).json()) as Respuesta;
    expect(uno.created).toBe(true);

    const res = await peticion({ phone: "525550001234", name: "Ana" }, KEY);
    const dos = (await res.json()) as Respuesta;

    expect(res.status).toBe(200);
    // 200 y NO 409: quien llama es una máquina que reintenta, y un conflicto la
    // mandaría a escalar un alta que en realidad ya está hecha.
    expect(dos.created).toBe(false);
    expect(dos.contact.id).toBe(uno.contact.id);
    expect(dos.lead?.id).toBe(uno.lead?.id);

    expect(estado.contactos.size).toBe(1);
    expect(estado.leads.size).toBe(1);
  });

  it("el mismo teléfono escrito con prefijo 521 también es el mismo contacto", async () => {
    await peticion({ phone: "525550001234", name: "Ana" }, KEY);
    const res = await peticion({ phone: "5215550001234", name: "Ana" }, KEY);
    expect(res.status).toBe(200);
    expect(estado.contactos.size).toBe(1);
  });

  it("un contacto que YA tenía lead (porque escribió antes) vuelve con su lead, sin crear otro", async () => {
    // Estado previo: el contacto existe y ya está en el embudo.
    estado.contactos.set("525550001234", {
      id: "ct_prev",
      name: "Ana",
      waIdentity: "525550001234",
      phone: "525550001234",
      channel: "whatsapp",
    });
    estado.leads.set("ct_prev", { id: "lead_prev", stageId: "ps_1" });

    const res = await peticion({ phone: "525550001234", name: "Ana" }, KEY);
    const body = (await res.json()) as Respuesta;

    expect(res.status).toBe(200);
    expect(body.created).toBe(false);
    expect(body.contact.id).toBe("ct_prev");
    expect(body.lead?.id).toBe("lead_prev");
    expect(estado.leads.size).toBe(1);
  });

  it("tablero sin etapas abiertas y sin lead previo → 422 no_stage (un lead sin embudo no es un lead)", async () => {
    estado.etapas = false;
    const res = await peticion({ phone: "525550001234", name: "Ana" }, KEY);
    expect(res.status).toBe(422);
    expect((await res.json()) as Respuesta).toMatchObject({ error: { code: "no_stage" } });
  });

  it("tablero sin etapas pero el contacto ya tenía lead → 200 con el de antes (el lead manda)", async () => {
    estado.contactos.set("525550001234", {
      id: "ct_prev",
      name: "Ana",
      waIdentity: "525550001234",
      phone: "525550001234",
      channel: "whatsapp",
    });
    estado.leads.set("ct_prev", { id: "lead_prev", stageId: "ps_1" });
    estado.etapas = false;

    const res = await peticion({ phone: "525550001234", name: "Ana" }, KEY);
    const body = (await res.json()) as Respuesta;
    expect(res.status).toBe(200);
    expect(body.lead?.id).toBe("lead_prev");
  });
});

describe("POST /api/bot/contacts — la identidad no la manda el cuerpo", () => {
  it("una identidad ajena en el cuerpo se ignora: la llave sale del teléfono", async () => {
    const res = await peticion(
      {
        phone: "525550001234",
        name: "Ana",
        waIdentity: "bsuid:ajeno",
        identity: "ig:ajeno",
        channel: "instagram",
      },
      KEY
    );
    const body = (await res.json()) as Respuesta;

    expect(res.status).toBe(201);
    expect(estado.identidades).toEqual(["525550001234"]);
    expect(estado.contactos.has("bsuid:ajeno")).toBe(false);
    expect(estado.contactos.has("ig:ajeno")).toBe(false);
    expect(body.contact.phone).toBe("525550001234");
  });

  it("una identidad de otro canal en el campo phone es un 422, no un atajo", async () => {
    for (const phone of ["bsuid:MX.bsu.1", "ig:12345", "fb:999", "tt:777"]) {
      const res = await peticion({ phone, name: "Ana" }, KEY);
      expect(res.status, phone).toBe(422);
      expect((await res.json()) as Respuesta).toMatchObject({
        error: { code: "invalid_body" },
      });
    }
    expect(estado.contactos.size).toBe(0);
  });
});

describe("POST /api/bot/contacts — lo que no pasa", () => {
  it("sin teléfono → 422 tipado con el detalle del campo", async () => {
    const res = await peticion({ name: "Ana" }, KEY);
    expect(res.status).toBe(422);
    const body = (await res.json()) as Respuesta;
    expect(body.error?.code).toBe("invalid_body");
    expect(body.error?.message).toContain("phone");
    expect(estado.contactos.size).toBe(0);
  });

  it("sin nombre → 422 (un contacto sin nombre es un número archivado)", async () => {
    const res = await peticion({ phone: "525550001234" }, KEY);
    expect(res.status).toBe(422);
    expect((await res.json()) as Respuesta).toMatchObject({
      error: { code: "invalid_body" },
    });
    expect(estado.contactos.size).toBe(0);
  });

  it("un body que ni es JSON → 422, no un 500", async () => {
    const res = await peticion("esto no es json", KEY);
    expect(res.status).toBe(422);
    expect((await res.json()) as Respuesta).toMatchObject({
      error: { code: "invalid_body" },
    });
    expect(estado.contactos.size).toBe(0);
  });

  it("ni un contacto ni un lead sin la llave: también sin `BOT_API_KEY` configurada", async () => {
    vi.stubEnv("BOT_API_KEY", "");
    const res = await peticion({ phone: "525550001234", name: "Ana" }, KEY);
    expect(res.status).toBe(401);
    expect(estado.contactos.size).toBe(0);
  });
});