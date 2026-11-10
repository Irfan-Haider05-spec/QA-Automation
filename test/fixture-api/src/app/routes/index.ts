import express from "express";
import { AuthRoutes } from "../modules/auth/auth.routes";
import { PromotionRoutes } from "../modules/promotion/promotion.routes";
import { CustomerRoutes } from "../modules/customer/customer.routes";
import { AdminRoutes } from "../modules/admin/admin.routes";
import { ReportRoutes } from "../modules/report/report.routes";
import { ProductRoutes } from "../modules/product/product.routes";
import { SystemRoutes } from "../modules/system/system.routes";
import { NotificationRoutes } from "../modules/notification/notification.routes";
const router = express.Router();
const apiRoutes = [
  { path: "/auth", route: AuthRoutes },
  { path: "/promotion", route: PromotionRoutes },
  { path: "/customer", route: CustomerRoutes },
  { path: "/admin", route: AdminRoutes },
  { path: "/report-analytics", route: ReportRoutes },
  { path: "/product", route: ProductRoutes },
  { path: "/system", route: SystemRoutes },
  { path: "/notification", route: NotificationRoutes },
];
apiRoutes.forEach((r) => router.use(r.path, r.route));
export default router;
