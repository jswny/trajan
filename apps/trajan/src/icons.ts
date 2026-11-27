import type { Html } from "@effect/ui/html";
import arrowShortUp from "pierre-icon-assets/beta/svg/IconArrowShortUp/outline-12px.svg?url";
import arrowUp from "pierre-icon-assets/beta/svg/IconArrowUp/fill-16px.svg?url";
import check from "pierre-icon-assets/beta/svg/IconCheck/outline-16px.svg?url";
import chevron from "pierre-icon-assets/beta/svg/IconChevron/outline-12px.svg?url";
import close from "pierre-icon-assets/beta/svg/IconX/outline-16px.svg?url";
import ellipsis from "pierre-icon-assets/svg/IconEllipsis.svg?url";
import globe from "pierre-icon-assets/beta/svg/IconGlobe/outline-16px.svg?url";
import loader from "pierre-icon-assets/beta/svg/IconLoader/outline-16px.svg?url";
import stop from "pierre-icon-assets/beta/svg/IconSquircle/fill-12px.svg?url";

// Unmodified artwork from @pierre/icons (Apache-2.0). See licenses/apache-pierre-icons.txt.
const icons = { arrowShortUp, arrowUp, check, chevron, close, ellipsis, globe, loader, stop };

export function Icon<M>(h: Html.H<M>, name: keyof typeof icons, size = 16, classes = "") {
	return h.span.class(`pierre-icon inline-block shrink-0 ${classes}`).attrs({
		"aria-hidden": "true",
		"data-icon": name,
		style: `width:${size}px;height:${size}px;mask-image:url("${icons[name]}")`,
	});
}
