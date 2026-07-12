import { relations } from "drizzle-orm";
import {
	boolean,
	index,
	jsonb,
	pgTable,
	text,
	timestamp,
	unique,
} from "drizzle-orm/pg-core";

// Physical table/column names mirror the existing PostgreSQL schema managed by
// Better Auth. DateTime maps to timestamp(3) without time zone; field names are
// used verbatim as column names (camelCase). Do not snake_case these.

export const user = pgTable(
	"user",
	{
		id: text("id").primaryKey(),
		name: text("name").notNull(),
		email: text("email").notNull(),
		emailVerified: boolean("emailVerified").notNull().default(false),
		image: text("image"),
		createdAt: timestamp("createdAt", { mode: "date", precision: 3 })
			.notNull()
			.defaultNow(),
		updatedAt: timestamp("updatedAt", { mode: "date", precision: 3 })
			.notNull()
			.defaultNow()
			.$onUpdate(() => new Date()),
	},
	(table) => [unique().on(table.email)]
);

export const session = pgTable(
	"session",
	{
		id: text("id").primaryKey(),
		expiresAt: timestamp("expiresAt", { mode: "date", precision: 3 }).notNull(),
		token: text("token").notNull(),
		createdAt: timestamp("createdAt", { mode: "date", precision: 3 })
			.notNull()
			.defaultNow(),
		updatedAt: timestamp("updatedAt", { mode: "date", precision: 3 })
			.notNull()
			.defaultNow()
			.$onUpdate(() => new Date()),
		ipAddress: text("ipAddress"),
		userAgent: text("userAgent"),
		userId: text("userId")
			.notNull()
			.references(() => user.id, { onDelete: "cascade" }),
	},
	(table) => [unique().on(table.token), index().on(table.userId)]
);

export const account = pgTable(
	"account",
	{
		id: text("id").primaryKey(),
		accountId: text("accountId").notNull(),
		providerId: text("providerId").notNull(),
		userId: text("userId")
			.notNull()
			.references(() => user.id, { onDelete: "cascade" }),
		accessToken: text("accessToken"),
		refreshToken: text("refreshToken"),
		idToken: text("idToken"),
		accessTokenExpiresAt: timestamp("accessTokenExpiresAt", {
			mode: "date",
			precision: 3,
		}),
		refreshTokenExpiresAt: timestamp("refreshTokenExpiresAt", {
			mode: "date",
			precision: 3,
		}),
		scope: text("scope"),
		password: text("password"),
		createdAt: timestamp("createdAt", { mode: "date", precision: 3 })
			.notNull()
			.defaultNow(),
		updatedAt: timestamp("updatedAt", { mode: "date", precision: 3 })
			.notNull()
			.defaultNow()
			.$onUpdate(() => new Date()),
	},
	(table) => [index().on(table.userId)]
);

export const verification = pgTable(
	"verification",
	{
		id: text("id").primaryKey(),
		identifier: text("identifier").notNull(),
		value: text("value").notNull(),
		expiresAt: timestamp("expiresAt", { mode: "date", precision: 3 }).notNull(),
		createdAt: timestamp("createdAt", { mode: "date", precision: 3 })
			.notNull()
			.defaultNow(),
		updatedAt: timestamp("updatedAt", { mode: "date", precision: 3 })
			.notNull()
			.defaultNow()
			.$onUpdate(() => new Date()),
	},
	(table) => [index().on(table.identifier)]
);

export const oauthClient = pgTable(
	"oauthClient",
	{
		id: text("id").primaryKey(),
		clientId: text("clientId").notNull().unique(),
		clientSecret: text("clientSecret"),
		disabled: boolean("disabled").default(false),
		skipConsent: boolean("skipConsent"),
		enableEndSession: boolean("enableEndSession"),
		subjectType: text("subjectType"),
		scopes: text("scopes").array(),
		userId: text("userId").references(() => user.id, { onDelete: "cascade" }),
		createdAt: timestamp("createdAt", { mode: "date", precision: 3 })
			.notNull()
			.defaultNow(),
		updatedAt: timestamp("updatedAt", { mode: "date", precision: 3 })
			.notNull()
			.defaultNow()
			.$onUpdate(() => new Date()),
		name: text("name"),
		uri: text("uri"),
		icon: text("icon"),
		contacts: text("contacts").array(),
		tos: text("tos"),
		policy: text("policy"),
		softwareId: text("softwareId"),
		softwareVersion: text("softwareVersion"),
		softwareStatement: text("softwareStatement"),
		redirectUris: text("redirectUris").array().notNull(),
		postLogoutRedirectUris: text("postLogoutRedirectUris").array(),
		tokenEndpointAuthMethod: text("tokenEndpointAuthMethod"),
		grantTypes: text("grantTypes").array(),
		responseTypes: text("responseTypes").array(),
		public: boolean("public"),
		type: text("type"),
		requirePKCE: boolean("requirePKCE"),
		referenceId: text("referenceId"),
		metadata: jsonb("metadata"),
	},
	(table) => [index().on(table.userId)]
);

export const oauthRefreshToken = pgTable(
	"oauthRefreshToken",
	{
		id: text("id").primaryKey(),
		token: text("token").notNull().unique(),
		clientId: text("clientId")
			.notNull()
			.references(() => oauthClient.clientId),
		sessionId: text("sessionId").references(() => session.id, {
			onDelete: "set null",
		}),
		userId: text("userId")
			.notNull()
			.references(() => user.id),
		referenceId: text("referenceId"),
		expiresAt: timestamp("expiresAt", { mode: "date", precision: 3 }).notNull(),
		createdAt: timestamp("createdAt", { mode: "date", precision: 3 }).notNull(),
		revoked: timestamp("revoked", { mode: "date", precision: 3 }),
		authTime: timestamp("authTime", { mode: "date", precision: 3 }),
		scopes: text("scopes").array().notNull(),
	},
	(table) => [index().on(table.clientId), index().on(table.userId)]
);

export const oauthAccessToken = pgTable(
	"oauthAccessToken",
	{
		id: text("id").primaryKey(),
		token: text("token").notNull().unique(),
		clientId: text("clientId")
			.notNull()
			.references(() => oauthClient.clientId),
		sessionId: text("sessionId").references(() => session.id, {
			onDelete: "set null",
		}),
		userId: text("userId").references(() => user.id),
		referenceId: text("referenceId"),
		refreshId: text("refreshId").references(() => oauthRefreshToken.id),
		expiresAt: timestamp("expiresAt", { mode: "date", precision: 3 }).notNull(),
		createdAt: timestamp("createdAt", { mode: "date", precision: 3 }).notNull(),
		scopes: text("scopes").array().notNull(),
	},
	(table) => [index().on(table.clientId), index().on(table.userId)]
);

export const apiKey = pgTable(
	"apiKey",
	{
		id: text("id").primaryKey(),
		userId: text("userId")
			.notNull()
			.references(() => user.id, { onDelete: "cascade" }),
		lookupPrefix: text("lookupPrefix").notNull(),
		secretHash: text("secretHash").notNull(),
		scopes: text("scopes").array().notNull(),
		expiresAt: timestamp("expiresAt", { mode: "date", precision: 3 }),
		revokedAt: timestamp("revokedAt", { mode: "date", precision: 3 }),
		createdAt: timestamp("createdAt", { mode: "date", precision: 3 })
			.notNull()
			.defaultNow(),
		updatedAt: timestamp("updatedAt", { mode: "date", precision: 3 })
			.notNull()
			.defaultNow()
			.$onUpdate(() => new Date()),
	},
	(table) => [index().on(table.userId), unique().on(table.lookupPrefix)]
);

export const oauthConsent = pgTable(
	"oauthConsent",
	{
		id: text("id").primaryKey(),
		clientId: text("clientId")
			.notNull()
			.references(() => oauthClient.clientId),
		userId: text("userId").references(() => user.id, { onDelete: "cascade" }),
		referenceId: text("referenceId"),
		scopes: text("scopes").array().notNull(),
		createdAt: timestamp("createdAt", { mode: "date", precision: 3 }).notNull(),
		updatedAt: timestamp("updatedAt", { mode: "date", precision: 3 }).notNull(),
	},
	(table) => [index().on(table.clientId), index().on(table.userId)]
);

export const jwks = pgTable("jwks", {
	id: text("id").primaryKey(),
	publicKey: text("publicKey").notNull(),
	privateKey: text("privateKey").notNull(),
	createdAt: timestamp("createdAt", { mode: "date", precision: 3 })
		.notNull()
		.defaultNow(),
	expiresAt: timestamp("expiresAt", { mode: "date", precision: 3 }),
});

export const userRelations = relations(user, ({ many }) => ({
	accounts: many(account),
	sessions: many(session),
}));

export const sessionRelations = relations(session, ({ one }) => ({
	user: one(user, { fields: [session.userId], references: [user.id] }),
}));

export const accountRelations = relations(account, ({ one }) => ({
	user: one(user, { fields: [account.userId], references: [user.id] }),
}));
