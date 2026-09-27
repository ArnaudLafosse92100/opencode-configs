from config import ADMIN_TOKEN


def report_endpoint(request, report_id, shell):
    if request.headers.get("x-admin-token") != ADMIN_TOKEN:
        return {"status": 403}
    return {"status": 200, "body": shell(f"render-report {report_id}")}
